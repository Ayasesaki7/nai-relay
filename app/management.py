import asyncio
import json
import os
import re

import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

from . import config


def bearer(request):
    token = request.headers.get('authorization', '').strip()
    return token[7:].strip() if token[:7].lower() == 'bearer ' else token


def create_router(store, get_client, get_queue):
    router = APIRouter(prefix='/proxy/manage')
    upstream_lock = asyncio.Lock()

    def owner(request):
        user = store.identity(bearer(request))
        if not user:
            raise HTTPException(401, '中转 Key 无效或已停用')
        if not user['owner']:
            raise HTTPException(403, '此 Key 没有管理权限')
        origin = request.headers.get('origin')
        host = request.headers.get('host', '')
        domain = os.environ.get('DOMAIN', '')
        allowed = {'https://' + domain} if domain else {str(request.base_url).rstrip('/')}
        if host.startswith(('127.0.0.1:', 'localhost:')):
            allowed.add(str(request.base_url).rstrip('/'))
        if ((origin and origin not in allowed) or
            request.headers.get('sec-fetch-site') in ['cross-site', 'same-site'] or
            (request.method != 'GET' and not origin)):
            raise HTTPException(403, '管理操作只能从本站提交，请刷新页面后重试')
        return user

    async def body(request, allowed):
        raw = await request.body()
        if len(raw) > 4096:
            raise HTTPException(413, '请求过大')
        try:
            values = json.loads(raw or b'{}')
        except ValueError:
            raise HTTPException(400, '无效 JSON')
        if not isinstance(values, dict) or set(values) - set(allowed):
            raise HTTPException(400, '不支持的字段')
        return values

    def reply(value):
        return JSONResponse(value, headers={'Cache-Control': 'no-store'})

    async def verify(token):
        headers = {'Authorization': 'Bearer ' + token, 'User-Agent': config.USER_AGENT,
                   'Origin': config.ORIGIN, 'Referer': config.ORIGIN + '/'}
        try:
            response = await get_client().get(config.IMAGE_UPSTREAM + '/user/subscription', headers=headers)
            if response.status_code != 200:
                raise HTTPException(400, f'PST 验证失败（NAI HTTP {response.status_code}），原配置保持不变')
            result = response.json()
            if not isinstance(result.get('tier'), int):
                raise ValueError('unexpected subscription')
            return {k: result.get(k) for k in ['tier', 'active', 'trainingStepsLeft', 'usage']}
        except (httpx.HTTPError, ValueError, AttributeError):
            raise HTTPException(502, '暂时无法验证 NAI 账户，原配置保持不变') from None

    @router.get('')
    async def summary(request: Request):
        user = owner(request)
        return reply({**store.summary(), 'current_id': user['id'], 'queue': get_queue()})

    @router.post('/upstream')
    @router.post('/upstream/check')
    async def upstream(request: Request):
        owner(request)
        values = await body(request, ['token'])
        async with upstream_lock:
            token = values.get('token') if not request.url.path.endswith('/check') else store.upstream_token
            if not isinstance(token, str) or not re.fullmatch(r'pst-[A-Za-z0-9_-]{20,256}', token):
                raise HTTPException(400, '请输入完整的 pst- 开头的官方 Token')
            subscription = await verify(token)
            store.upstream(token, subscription)
            return reply({'ok': True, 'subscription': subscription, 'upstream': store.summary()['upstream']})

    @router.post('/keys')
    async def create(request: Request):
        owner(request)
        return reply(change('create', await body(request, ['name', 'key'])))

    def change(action, values, key_id=None):
        try:
            return store.change(action, values, key_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None

    @router.get('/keys/{key_id}/secret')
    async def reveal(key_id: str, request: Request):
        owner(request)
        try:
            return reply({'key': store.key(key_id)})
        except StopIteration:
            raise HTTPException(404, 'Key 不存在') from None

    @router.patch('/keys/{key_id}')
    async def edit(key_id: str, request: Request):
        owner(request)
        return reply(change('edit', await body(request, ['name', 'enabled']), key_id))

    @router.post('/keys/{key_id}/rotate')
    async def rotate(key_id: str, request: Request):
        owner(request)
        return reply(change('rotate', await body(request, ['key']), key_id))

    @router.delete('/keys/{key_id}')
    async def delete(key_id: str, request: Request):
        owner(request)
        return reply(change('delete', await body(request, []), key_id))

    return router
