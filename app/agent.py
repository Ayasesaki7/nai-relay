"""生图助手：网页里的对话助手经服务器调用大模型。

大模型的 key 只存在服务器上（data/agent.json，权限 600），网页拿不到原文。
服务器只做三件事：保存各人的模型连接、转发对话、把各家不同的流式格式统一成一种。
助手要用的工具（查 TAG、改提示词、生图……）都在网页里执行，由网页把结果再发回来。

支持三种连接：
- DeepSeek：OpenAI 格式，地址固定；
- OpenAI 兼容：OpenAI、OpenRouter、通义千问等，自己填地址；
- Vertex AI：Gemini 原生格式，用服务账号 JSON 或 Express 模式的 API key。

技能（SKILL.md）存在各人的 userdata（skills.json），由网页读写；
这里只负责把管理员标了「共享」的技能发给其他人（只读）。
"""
import asyncio
import base64
import copy
import functools
import ipaddress
import json
import os
import re
import secrets
import socket
import tempfile
import threading
import time
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, StreamingResponse

from . import logger as log
from .management import bearer

PRESETS = {
    'deepseek': {'label': 'DeepSeek', 'format': 'openai', 'base_url': 'https://api.deepseek.com',
                 # 2026-10 起：flash 是 V4.1 Flash（能看图），v4-pro 不能看图；旧名 deepseek-chat 等以官方为准，可点「拉取」看最新
                 'models': ['deepseek-flash', 'deepseek-v4-pro'],
                 # 思考强度：off 关掉思考，其余按 reasoning_effort 传（官方只有 low / high / max）
                 'efforts': ['off', 'low', 'high', 'max']},
    'openai': {'label': 'OpenAI 兼容', 'format': 'openai', 'base_url': None, 'models': [],
               # 按 OpenAI 的 reasoning_effort 原样传，各家支持的值不一样
               'efforts': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
               # 常用的兼容地址，网页上点一下就填好
               'templates': [
                   {'name': 'OpenAI', 'base_url': 'https://api.openai.com/v1'},
                   {'name': 'OpenRouter', 'base_url': 'https://openrouter.ai/api/v1'},
                   {'name': '通义千问', 'base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1'},
                   {'name': '硅基流动', 'base_url': 'https://api.siliconflow.cn/v1'},
                   {'name': 'Kimi', 'base_url': 'https://api.moonshot.cn/v1'},
                   {'name': '智谱', 'base_url': 'https://open.bigmodel.cn/api/paas/v4'},
               ]},
    'vertex': {'label': 'Vertex AI（Gemini）', 'format': 'gemini', 'base_url': None,
               'models': ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview'],
               # thinkingConfig.thinkingLevel；各型号支持的档位不同（3 Pro 只有 low / high）
               'efforts': ['minimal', 'low', 'medium', 'high']},
}

TOKEN_URL = 'https://oauth2.googleapis.com/token'
MAX_CONNECTIONS = 20  # 每人
MAX_BODY = 40 << 20
MAX_IMAGES = 24
MAX_IMAGE_B64 = 6 << 20
IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/webp'}
GEMINI_SCHEMA_KEYS = {'type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items',
                      'minItems', 'maxItems', 'minimum', 'maximum'}
GEMINI_SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                 'HARM_CATEGORY_DANGEROUS_CONTENT']


class Bad(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def _error(status, message):
    return JSONResponse({'statusCode': status, 'message': message}, status_code=status,
                        headers={'Cache-Control': 'no-store'})


def _now():
    return int(time.time())


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


# ---------- 保存连接 ----------

class AgentStore:
    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._data = None

    def _load(self):
        if self._data is None:
            if self.path.is_file():
                self._data = json.loads(self.path.read_text(encoding='utf-8'))
            else:
                self._data = {'version': 1, 'connections': [], 'usage': {}}
        return self._data

    def _commit(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, name = tempfile.mkstemp(dir=self.path.parent, prefix='.agent-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                os.chmod(name, 0o600)
                json.dump(data, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
            self._data = data
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def visible(self, uid):
        with self._lock:
            return [copy.deepcopy(c) for c in self._load()['connections'] if c['owner'] == uid or c.get('shared')]

    def get(self, conn_id, uid):
        with self._lock:
            c = next((c for c in self._load()['connections'] if c['id'] == conn_id), None)
            if not c or (c['owner'] != uid and not c.get('shared')):
                raise Bad(404, '没有这个连接')
            return copy.deepcopy(c)

    def save(self, conn):
        with self._lock:
            data = copy.deepcopy(self._load())
            rows = data['connections']
            i = next((i for i, c in enumerate(rows) if c['id'] == conn['id']), None)
            if i is None:
                if sum(c['owner'] == conn['owner'] for c in rows) >= MAX_CONNECTIONS:
                    raise Bad(400, f'每人最多保存 {MAX_CONNECTIONS} 个连接')
                rows.append(conn)
            else:
                rows[i] = conn
            self._commit(data)

    def delete(self, conn_id, uid):
        with self._lock:
            data = copy.deepcopy(self._load())
            before = len(data['connections'])
            data['connections'] = [c for c in data['connections'] if not (c['id'] == conn_id and c['owner'] == uid)]
            if len(data['connections']) == before:
                raise Bad(404, '没有这个连接')
            self._commit(data)

    def used(self, uid, conn_id):
        with self._lock:
            return self._load()['usage'].get(date.today().isoformat(), {}).get(f'{uid}:{conn_id}', 0)

    def count(self, uid, conn_id, limit):
        """共享连接按人按天计次；超过上限返回 False"""
        with self._lock:
            data = copy.deepcopy(self._load())
            today = date.today().isoformat()
            usage = {d: v for d, v in data['usage'].items() if d >= today}  # 只留今天
            day = usage.setdefault(today, {})
            k = f'{uid}:{conn_id}'
            if limit and day.get(k, 0) >= limit:
                return False
            day[k] = day.get(k, 0) + 1
            data['usage'] = usage
            self._commit(data)
            return True


def _mask(key):
    return '…' + key[-4:] if len(key) > 12 else '已保存'


def public(c, uid):
    mine = c['owner'] == uid
    out = {k: c.get(k) for k in ('id', 'name', 'preset', 'model', 'shared', 'daily_limit', 'created_at')}
    out.update(mine=mine, label=PRESETS[c['preset']]['label'])
    if mine:
        out.update(base_url=c.get('base_url'), project=c.get('project'), location=c.get('location'), auth=c.get('auth'),
                   key_hint=_mask(c['key']) if c['preset'] != 'vertex' or c.get('auth') == 'key'
                   else (c.get('sa_email') or '服务账号'))
    return out


def _text(v, field, lo, hi):
    if not isinstance(v, str):
        raise Bad(400, f'{field} 必须是文字')
    v = v.strip()
    if not lo <= len(v) <= hi or any(ord(ch) < 32 for ch in v):
        raise Bad(400, f'{field} 长度需为 {lo}–{hi} 个字符')
    return v


def check_base_url(url, trusted):
    url = _text(url, 'API 地址', 8, 300).rstrip('/')
    u = urlsplit(url)
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise Bad(400, 'API 地址格式不对，应类似 https://api.example.com/v1')
    if not trusted:
        if u.scheme != 'https':
            raise Bad(400, 'API 地址必须是 https')
        _public_host(u.hostname)
    return url


def _public_host(host):
    """不让普通用户把请求打到服务器内网（本机、Docker 网络、云厂商元数据地址）"""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')) or '.' not in host:
            raise Bad(400, 'API 地址不能指向内网')
        return
    if not ip.is_global:
        raise Bad(400, 'API 地址不能指向内网')


async def _resolve_public(url):
    host, port = urlsplit(url).hostname, urlsplit(url).port or 443
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise Bad(502, f'解析不了 {host}')
    for info in infos:
        if not ipaddress.ip_address(info[4][0].split('%')[0]).is_global:
            raise Bad(400, 'API 地址不能指向内网')


def _service_account(raw):
    try:
        sa = json.loads(raw)
        assert isinstance(sa, dict) and sa.get('type') == 'service_account'
        assert isinstance(sa.get('client_email'), str) and isinstance(sa.get('private_key'), str)
    except (ValueError, AssertionError):
        raise Bad(400, '服务账号 JSON 不对：请在 Google Cloud 控制台「IAM → 服务账号 → 密钥」里新建 JSON 密钥，把整个文件内容贴进来')
    from cryptography.hazmat.primitives import serialization
    try:
        serialization.load_pem_private_key(sa['private_key'].encode(), None)
    except (ValueError, TypeError):
        raise Bad(400, '服务账号 JSON 里的私钥读不出来，文件可能不完整')
    return sa


def build_connection(values, old, ident):
    """校验网页提交的连接设置。old 为 None 表示新建；key 留空表示沿用原来的"""
    allowed = {'name', 'preset', 'base_url', 'key', 'model', 'project', 'location', 'auth', 'shared', 'daily_limit'}
    if not isinstance(values, dict) or set(values) - allowed:
        raise Bad(400, '不支持的字段')
    c = copy.deepcopy(old) if old else {'id': secrets.token_hex(8), 'owner': ident['id'], 'created_at': _now(),
                                        'trusted': bool(ident['owner'])}
    preset = values.get('preset', c.get('preset'))
    if preset not in PRESETS:
        raise Bad(400, '不支持这种连接')
    if old and preset != old['preset']:
        raise Bad(400, '不能改连接类型，请新建一个')
    c['preset'] = preset
    c['name'] = _text(values.get('name', c.get('name') or PRESETS[preset]['label']), '名称', 1, 40)
    c['model'] = _text(values.get('model', c.get('model') or (PRESETS[preset]['models'] or [''])[0] or 'x'), '模型', 1, 200)
    key = values.get('key') or ''
    if not isinstance(key, str) or len(key) > 20000:
        raise Bad(400, 'key 太长了')
    key = key.strip()
    need_key = False
    if preset == 'openai':
        url = check_base_url(values.get('base_url', c.get('base_url') or ''), c['trusted'])
        # 换了地址必须重新填 key，免得把原来的 key 发到别的地方
        need_key = old is not None and url != old.get('base_url')
        c['base_url'] = url
    elif preset == 'deepseek':
        c['base_url'] = PRESETS['deepseek']['base_url']
    else:
        auth = values.get('auth', c.get('auth') or 'sa')
        if auth not in ('sa', 'key'):
            raise Bad(400, 'Vertex 的认证方式只能是服务账号或 API key')
        need_key = old is not None and auth != old.get('auth')
        c['auth'] = auth
        loc = values.get('location', c.get('location') or 'global') or 'global'
        if not isinstance(loc, str) or not re.fullmatch(r'[a-z0-9-]{2,40}', loc):
            raise Bad(400, '区域格式不对，比如 global、us-central1')
        c['location'] = loc
        if not re.fullmatch(r'[A-Za-z0-9._@-]{1,120}', c['model']):
            raise Bad(400, '模型名格式不对，比如 gemini-2.5-pro')
    if key:
        if preset == 'vertex' and c['auth'] == 'sa':
            sa = _service_account(key)
            key = json.dumps(sa, separators=(',', ':'))
            c['sa_email'] = sa['client_email'][:120]
            c.setdefault('project', None)
            if not values.get('project') and not (old and old.get('auth') == 'sa' and old.get('project')):
                c['project'] = sa.get('project_id')
        elif len(key) > 500 or any(ch.isspace() or ord(ch) < 32 for ch in key):
            raise Bad(400, 'key 格式不对')
        c['key'] = key
    elif old is None or need_key:
        raise Bad(400, '请填写 key' if old is None else '换了地址或认证方式，需要重新填写 key')
    if preset == 'vertex':
        if c['auth'] == 'key':
            c.pop('sa_email', None)
            c['project'] = None
        else:
            project = values.get('project', c.get('project')) or ''
            if not isinstance(project, str) or not re.fullmatch(r'[a-z][a-z0-9-]{4,62}', project):
                raise Bad(400, '项目 ID 格式不对（服务账号 JSON 里的 project_id）')
            c['project'] = project
    if 'shared' in values or 'daily_limit' in values:
        if not ident['owner'] and (values.get('shared') or values.get('daily_limit')):
            raise Bad(403, '只有管理员能把连接共享给所有人')
    shared = values.get('shared', c.get('shared', False))
    limit = values.get('daily_limit', c.get('daily_limit', 0))
    if type(shared) is not bool or type(limit) is not int or not 0 <= limit <= 100000:
        raise Bad(400, '共享设置不对')
    c['shared'], c['daily_limit'] = shared and bool(ident['owner']), limit
    c['updated_at'] = _now()
    return c


# ---------- 调大模型 ----------

class Upstream:
    def __init__(self, get_client):
        self.get_client = get_client
        self._tokens = {}  # 服务账号 → (access token, 过期时间)

    async def _sa_token(self, c):
        cache_key = c['id'] + ':' + str(hash(c['key']))
        hit = self._tokens.get(cache_key)
        if hit and hit[1] > _now() + 60:
            return hit[0]
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        sa = json.loads(c['key'])
        now = _now()
        head = {'alg': 'RS256', 'typ': 'JWT'}
        if sa.get('private_key_id'):
            head['kid'] = sa['private_key_id']
        claims = {'iss': sa['client_email'], 'scope': 'https://www.googleapis.com/auth/cloud-platform',
                  'aud': TOKEN_URL, 'iat': now, 'exp': now + 3600}
        signing = _b64url(json.dumps(head).encode()) + '.' + _b64url(json.dumps(claims).encode())
        pk = serialization.load_pem_private_key(sa['private_key'].encode(), None)
        jwt = signing + '.' + _b64url(pk.sign(signing.encode(), padding.PKCS1v15(), hashes.SHA256()))
        try:
            r = await self.get_client().post(TOKEN_URL, data={'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                                              'assertion': jwt}, timeout=30)
        except httpx.HTTPError as e:
            raise Bad(502, f'连不上 Google 登录服务：{type(e).__name__}')
        if r.status_code != 200:
            raise Bad(502, f'服务账号登录失败（{r.status_code}）：{_upstream_message(r.content)}')
        j = r.json()
        self._tokens[cache_key] = (j['access_token'], now + int(j.get('expires_in', 3600)))
        return j['access_token']

    async def _vertex(self, c, model, method):
        loc = c.get('location') or 'global'
        if c['auth'] == 'key':
            return (f'https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:{method}',
                    {'x-goog-api-key': c['key']})
        host = 'aiplatform.googleapis.com' if loc == 'global' else f'{loc}-aiplatform.googleapis.com'
        return (f'https://{host}/v1/projects/{c["project"]}/locations/{loc}/publishers/google/models/{model}:{method}',
                {'Authorization': 'Bearer ' + await self._sa_token(c)})

    async def _guard(self, c):
        if c['preset'] == 'openai' and not c.get('trusted'):
            await _resolve_public(c['base_url'])

    async def models(self, c):
        await self._guard(c)
        client = self.get_client()
        if c['preset'] == 'vertex':
            fallback = {'items': PRESETS['vertex']['models'], 'fallback': True}
            try:
                if c['auth'] == 'key':
                    url, headers = 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models', {'x-goog-api-key': c['key']}
                else:
                    loc = c.get('location') or 'global'
                    host = 'aiplatform.googleapis.com' if loc == 'global' else f'{loc}-aiplatform.googleapis.com'
                    url = f'https://{host}/v1beta1/publishers/google/models'
                    headers = {'Authorization': 'Bearer ' + await self._sa_token(c), 'x-goog-user-project': c['project']}
                r = await client.get(url, params={'pageSize': 300}, headers=headers, timeout=20)
                if r.status_code != 200:
                    return fallback
                names = sorted({m['name'].rsplit('/', 1)[-1] for m in r.json().get('publisherModels', [])
                                if 'gemini' in m.get('name', '')}, reverse=True)
                return {'items': names} if names else fallback
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                return fallback
        try:
            r = await client.get(c['base_url'] + '/models', headers={'Authorization': 'Bearer ' + c['key']}, timeout=20)
        except httpx.HTTPError as e:
            raise Bad(502, f'连不上 {urlsplit(c["base_url"]).hostname}：{type(e).__name__}')
        if r.status_code != 200:
            raise _map_status(r.status_code, r.content, c)
        try:
            items = sorted({m['id'] for m in r.json()['data'] if isinstance(m.get('id'), str)})
        except (ValueError, KeyError, TypeError):
            raise Bad(502, '模型列表的格式看不懂，可以直接手填模型名')
        return {'items': items[:500]}

    async def open_stream(self, c, model, system, messages, tools, effort=''):
        """开始一次对话；返回 (httpx 响应, 解析器)。出错直接抛 Bad"""
        await self._guard(c)
        if c['preset'] == 'vertex':
            url, headers = await self._vertex(c, model, 'streamGenerateContent')
            url += '?alt=sse'
            body = to_gemini(system, messages, tools, effort)
            parse = GeminiStream()
        else:
            url = c['base_url'] + '/chat/completions'
            headers = {'Authorization': 'Bearer ' + c['key']}
            body = to_openai(system, messages, tools, model, deepseek=c['preset'] == 'deepseek', effort=effort)
            parse = OpenAIStream()
        headers['Accept'] = 'text/event-stream'
        client = self.get_client()
        try:
            req = client.build_request('POST', url, json=body, headers={**headers, 'User-Agent': 'nai-relay/1.0'})
            resp = await client.send(req, stream=True)
        except httpx.HTTPError as e:
            raise Bad(502, f'连不上大模型服务：{type(e).__name__}')
        if resp.status_code >= 400:
            try:
                content = await resp.aread()
            finally:
                await resp.aclose()
            raise _map_status(resp.status_code, content, c)
        return resp, parse


def _upstream_message(content):
    try:
        j = json.loads(content)
        if isinstance(j, list) and j:
            j = j[0]
        err = j.get('error', j) if isinstance(j, dict) else {}
        msg = err.get('message') if isinstance(err, dict) else err
        msg = msg if isinstance(msg, str) and msg else content.decode('utf-8', 'replace')
    except ValueError:
        msg = content.decode('utf-8', 'replace')
    return re.sub(r'\s+', ' ', msg).strip()[:300]


def _map_status(status, content, c):
    msg = _upstream_message(content)
    for secret in (c.get('key') or '', ):
        if len(secret) >= 8:
            msg = msg.replace(secret, '***')
    if status in (401, 403):
        return Bad(502, f'大模型服务拒绝了这个 key（{status}）：{msg}')
    if status == 402:
        return Bad(402, f'大模型账户余额不足：{msg}')
    if status == 429:
        return Bad(429, f'大模型服务限流或额度用完了：{msg}')
    if status == 404:
        return Bad(502, f'找不到这个模型或地址（404）：{msg}')
    if status < 500:
        return Bad(400, f'大模型服务报错（{status}）：{msg}')
    return Bad(502, f'大模型服务出错（{status}）：{msg}')


# ---------- 格式转换 ----------
# 网页发来的统一格式：
#   {role: user, text, images: [{mime, data}]}
#   {role: assistant, text, reasoning, sig, calls: [{id, name, args, sig}]}
#   {role: tool, id, name, result, images}

def check_messages(messages):
    if not isinstance(messages, list) or not 1 <= len(messages) <= 600:
        raise Bad(400, '对话内容不对')
    n = 0
    for m in messages:
        if not isinstance(m, dict) or m.get('role') not in ('user', 'assistant', 'tool'):
            raise Bad(400, '对话内容不对')
        for k in ('text', 'reasoning', 'result', 'sig', 'id', 'name'):
            if k in m and not isinstance(m[k], str):
                raise Bad(400, '对话内容不对')
        imgs = m.get('images') or []
        if not isinstance(imgs, list):
            raise Bad(400, '对话内容不对')
        for img in imgs:
            if (not isinstance(img, dict) or img.get('mime') not in IMAGE_MIMES or not isinstance(img.get('data'), str)
                    or len(img['data']) > MAX_IMAGE_B64):
                raise Bad(400, '图片格式不对，只支持 PNG、JPEG、WebP')
        n += len(imgs)
        calls = m.get('calls') or []
        if not isinstance(calls, list) or any(not isinstance(x, dict) or not isinstance(x.get('name'), str)
                                              or not isinstance(x.get('args', {}), dict) for x in calls):
            raise Bad(400, '对话内容不对')
    if n > MAX_IMAGES:
        raise Bad(400, f'一段对话最多带 {MAX_IMAGES} 张图，开个新对话吧')


def check_tools(tools):
    if not isinstance(tools, list) or len(tools) > 40:
        raise Bad(400, '工具列表不对')
    for t in tools:
        if (not isinstance(t, dict) or not isinstance(t.get('name'), str) or not re.fullmatch(r'[a-zA-Z0-9_]{1,64}', t['name'])
                or not isinstance(t.get('description', ''), str) or not isinstance(t.get('parameters', {}), dict)
                or len(json.dumps(t)) > 12000):
            raise Bad(400, '工具列表不对')


def _data_url(img):
    return f'data:{img["mime"]};base64,{img["data"]}'


def to_openai(system, messages, tools, model, deepseek=False, effort=''):
    out = [{'role': 'system', 'content': system}] if system else []
    pending = []  # 工具返回的图片：OpenAI 格式的工具结果只能是文字，图片放在紧跟着的一条用户消息里

    def flush():
        if pending:
            out.append({'role': 'user', 'content': [{'type': 'text', 'text': '（上面工具返回的图片）'}] +
                        [{'type': 'image_url', 'image_url': {'url': _data_url(i)}} for i in pending]})
            pending.clear()

    for i, m in enumerate(messages):
        if m['role'] != 'tool':
            flush()
        if m['role'] == 'user':
            imgs = m.get('images') or []
            text = m.get('text') or ''
            out.append({'role': 'user', 'content': text if not imgs else
                        ([{'type': 'text', 'text': text}] if text else []) +
                        [{'type': 'image_url', 'image_url': {'url': _data_url(x)}} for x in imgs]})
        elif m['role'] == 'assistant':
            d = {'role': 'assistant', 'content': m.get('text') or ''}
            if m.get('calls'):
                d['tool_calls'] = [{'id': x.get('id') or f'call_{i}_{j}', 'type': 'function',
                                    'function': {'name': x['name'], 'arguments': json.dumps(x.get('args') or {}, ensure_ascii=False)}}
                                   for j, x in enumerate(m['calls'])]
            # DeepSeek 带工具时，之前每一轮的思考过程都要原样带回去，否则报 400（不带工具时会被忽略）
            if deepseek and m.get('reasoning'):
                d['reasoning_content'] = m['reasoning']
            out.append(d)
        else:
            out.append({'role': 'tool', 'tool_call_id': m.get('id') or '', 'content': m.get('result') or ''})
            pending.extend(m.get('images') or [])
    flush()
    body = {'model': model, 'messages': out, 'stream': True}
    if deepseek:
        body['stream_options'] = {'include_usage': True}
        if effort == 'off':
            body['thinking'] = {'type': 'disabled'}
        elif effort:
            body['thinking'] = {'type': 'enabled'}
            body['reasoning_effort'] = effort
    elif effort:
        body['reasoning_effort'] = effort
    if tools:
        body['tools'] = [{'type': 'function', 'function': {'name': t['name'], 'description': t.get('description', ''),
                                                           'parameters': t.get('parameters') or {'type': 'object', 'properties': {}}}}
                         for t in tools]
    return body


def gemini_schema(s):
    if not isinstance(s, dict):
        return s
    out = {}
    for k, v in s.items():
        if k not in GEMINI_SCHEMA_KEYS:
            continue
        if k == 'type' and isinstance(v, str):
            v = v.upper()
        elif k == 'properties' and isinstance(v, dict):
            v = {name: gemini_schema(p) for name, p in v.items()}
        elif k == 'items':
            v = gemini_schema(v)
        out[k] = v
    return out


def to_gemini(system, messages, tools, effort=''):
    contents = []

    def push(role, parts):
        if contents and contents[-1]['role'] == role:
            contents[-1]['parts'].extend(parts)
        else:
            contents.append({'role': role, 'parts': parts})

    names = {}
    for m in messages:
        imgs = [{'inlineData': {'mimeType': x['mime'], 'data': x['data']}} for x in m.get('images') or []]
        if m['role'] == 'user':
            push('user', ([{'text': m['text']}] if m.get('text') else []) + imgs or [{'text': ' '}])
        elif m['role'] == 'assistant':
            parts = []
            if m.get('text'):
                p = {'text': m['text']}
                if m.get('sig'):
                    p['thoughtSignature'] = m['sig']
                parts.append(p)
            for x in m.get('calls') or []:
                p = {'functionCall': {'name': x['name'], 'args': x.get('args') or {}}}
                if x.get('sig'):
                    p['thoughtSignature'] = x['sig']  # Gemini 3 要求原样带回
                parts.append(p)
                names[x.get('id')] = x['name']
            push('model', parts or [{'text': ' '}])
        else:
            name = m.get('name') or names.get(m.get('id')) or 'tool'
            push('user', [{'functionResponse': {'name': name, 'response': {'result': m.get('result') or ''}}}] + imgs)
    body = {'contents': contents,
            'safetySettings': [{'category': c, 'threshold': 'OFF'} for c in GEMINI_SAFETY]}
    if system:
        body['systemInstruction'] = {'parts': [{'text': system}]}
    if effort:
        body['generationConfig'] = {'thinkingConfig': {'thinkingLevel': effort.upper()}}
    if tools:
        decls = []
        for t in tools:
            d = {'name': t['name'], 'description': t.get('description', '')}
            params = gemini_schema(t.get('parameters') or {})
            if params.get('properties'):
                d['parameters'] = params
            decls.append(d)
        body['tools'] = [{'functionDeclarations': decls}]
    return body


# ---------- 解析流 ----------
# 统一的输出事件：{t: text|think|tool|sig|done|error, ...}

async def sse_lines(resp):
    buf = ''
    async for chunk in resp.aiter_text():
        buf += chunk
        while '\n' in buf:
            line, buf = buf.split('\n', 1)
            line = line.rstrip('\r')
            if line.startswith('data:'):
                yield line[5:].strip()
    if buf.strip().startswith('data:'):
        yield buf.strip()[5:].strip()


class OpenAIStream:
    async def events(self, resp):
        calls = {}
        finish = None
        usage = None
        async for data in sse_lines(resp):
            if data == '[DONE]':
                break
            try:
                j = json.loads(data)
            except ValueError:
                continue
            if isinstance(j.get('error'), dict):
                yield {'t': 'error', 'message': '大模型服务出错：' + str(j['error'].get('message', ''))[:300]}
                return
            usage = j.get('usage') or usage
            for ch in j.get('choices') or []:
                delta = ch.get('delta') or ch.get('message') or {}
                think = delta.get('reasoning_content') or delta.get('reasoning')
                if isinstance(think, str) and think:
                    yield {'t': 'think', 'd': think}
                if isinstance(delta.get('content'), str) and delta['content']:
                    yield {'t': 'text', 'd': delta['content']}
                for k, tc in enumerate(delta.get('tool_calls') or []):
                    slot = calls.setdefault(tc.get('index', k), {'id': '', 'name': '', 'args': ''})
                    slot['id'] = tc.get('id') or slot['id']
                    fn = tc.get('function') or {}
                    slot['name'] += fn.get('name') or ''
                    slot['args'] += fn.get('arguments') or ''
                finish = ch.get('finish_reason') or finish
        for idx in sorted(calls):
            x = calls[idx]
            try:
                args = json.loads(x['args'] or '{}')
                if not isinstance(args, dict):
                    raise ValueError
            except ValueError:
                args = {'_invalid': x['args'][:2000]}
            yield {'t': 'tool', 'id': x['id'] or f'call_{secrets.token_hex(4)}', 'name': x['name'], 'args': args}
        yield {'t': 'done', 'finish': finish, 'usage': _usage(usage)}


def _usage(u):
    if not isinstance(u, dict):
        return None
    pick = {'in': u.get('prompt_tokens', u.get('promptTokenCount')),
            'out': u.get('completion_tokens', u.get('candidatesTokenCount'))}
    return pick if any(isinstance(v, int) for v in pick.values()) else None


BLOCKED = {'SAFETY': '回答被 Gemini 的安全设置拦下了', 'PROHIBITED_CONTENT': '这个内容 Gemini 不肯处理',
           'BLOCKLIST': '回答里有被屏蔽的词', 'SPII': '回答涉及敏感个人信息，被拦下了', 'RECITATION': '回答和已有作品太像，被拦下了'}


class GeminiStream:
    async def events(self, resp):
        finish = None
        usage = None
        n = 0
        async for data in sse_lines(resp):
            try:
                j = json.loads(data)
            except ValueError:
                continue
            if isinstance(j.get('error'), dict):
                yield {'t': 'error', 'message': 'Gemini 出错：' + str(j['error'].get('message', ''))[:300]}
                return
            block = (j.get('promptFeedback') or {}).get('blockReason')
            if block:
                yield {'t': 'error', 'message': f'Gemini 拒绝处理这段对话（{block}），换个说法试试'}
                return
            usage = j.get('usageMetadata') or usage
            for cand in (j.get('candidates') or [])[:1]:
                for p in (cand.get('content') or {}).get('parts') or []:
                    if 'functionCall' in p:
                        fc = p['functionCall']
                        n += 1
                        ev = {'t': 'tool', 'id': f'call_{secrets.token_hex(4)}_{n}', 'name': fc.get('name', ''),
                              'args': fc.get('args') if isinstance(fc.get('args'), dict) else {}}
                        if p.get('thoughtSignature'):
                            ev['sig'] = p['thoughtSignature']
                        yield ev
                    elif isinstance(p.get('text'), str):
                        if p.get('thought'):
                            yield {'t': 'think', 'd': p['text']}
                        elif p['text']:
                            yield {'t': 'text', 'd': p['text']}
                        if p.get('thoughtSignature'):
                            yield {'t': 'sig', 'd': p['thoughtSignature']}
                    elif p.get('thoughtSignature'):
                        yield {'t': 'sig', 'd': p['thoughtSignature']}
                finish = cand.get('finishReason') or finish
        if finish in BLOCKED:
            yield {'t': 'error', 'message': BLOCKED[finish]}
            return
        yield {'t': 'done', 'finish': finish, 'usage': _usage(usage)}


SKILL_FILE_MAX = 256 << 10
SKILL_MAX_FILES = 30


def shared_skills(store, userdata, uid):
    """管理员共享的技能（不含自己的），只挑格式对的"""
    out = []
    for k in store.summary()['keys']:
        if not (k['owner'] and k['enabled']) or k['id'] == uid:
            continue
        try:
            data = userdata.read(k['id'], 'skills').get('data') or {}
        except (OSError, ValueError):
            continue
        for s in (data.get('skills') if isinstance(data, dict) else None) or []:
            if not (isinstance(s, dict) and s.get('shared') and s.get('enabled', True) is not False
                    and isinstance(s.get('id'), str) and re.fullmatch(r'[\w-]{1,40}', s['id'])
                    and isinstance(s.get('files'), dict) and isinstance(s['files'].get('SKILL.md'), str)):
                continue
            files = {p: t for p, t in list(s['files'].items())[:SKILL_MAX_FILES]
                     if isinstance(p, str) and isinstance(t, str) and len(p) <= 200 and len(t) <= SKILL_FILE_MAX}
            if 'SKILL.md' in files:
                out.append({'id': f'{k["id"][:8]}-{s["id"]}', 'owner': k['name'], 'files': files})
    return out


class _ClosingStream(StreamingResponse):
    """不管浏览器是中途断开还是根本没开始读，都要关掉上游连接、释放计数"""
    def __init__(self, content, on_close, **kw):
        super().__init__(content, **kw)
        self.on_close = on_close

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.on_close()


# ---------- 路由 ----------

def create_agent_router(store, agents: AgentStore, upstream: Upstream, userdata=None):
    router = APIRouter(prefix='/proxy/agent')
    active = {}

    def who(request):
        ident = store.identity(bearer(request))
        if not ident:
            raise Bad(401, 'Invalid proxy key')
        return ident

    async def body(request, limit=64 << 10):
        raw = await request.body()
        if len(raw) > limit:
            raise Bad(413, '请求太大')
        try:
            return json.loads(raw or b'{}')
        except ValueError:
            raise Bad(400, '请求格式不对')

    def handle(fn):
        @functools.wraps(fn)  # 保留原函数的参数，FastAPI 靠它解析路径参数
        async def wrapper(request: Request, **kw):
            try:
                return await fn(request, **kw)
            except Bad as e:
                return _error(e.status, e.message)
        return wrapper

    def view(c, ident):
        out = public(c, ident['id'])
        if c.get('shared') and c.get('daily_limit') and c['owner'] != ident['id']:
            out['used_today'] = agents.used(ident['id'], c['id'])
        return out

    @router.get('/config')
    @handle
    async def config(request: Request):
        ident = who(request)
        return JSONResponse({'presets': PRESETS, 'is_admin': bool(ident['owner']),
                             'connections': [view(c, ident) for c in agents.visible(ident['id'])]},
                            headers={'Cache-Control': 'no-store'})

    @router.get('/skills')
    @handle
    async def skills(request: Request):
        ident = who(request)
        items = shared_skills(store, userdata, ident['id']) if userdata else []
        return JSONResponse({'items': items}, headers={'Cache-Control': 'no-store'})

    @router.post('/connections')
    @handle
    async def create(request: Request):
        ident = who(request)
        c = build_connection(await body(request), None, ident)
        agents.save(c)
        log.event(evt='agent_conn', user=ident['name'], action='create', preset=c['preset'], shared=c['shared'])
        return view(c, ident)

    @router.patch('/connections/{conn_id}')
    @handle
    async def edit(request: Request, conn_id: str):
        ident = who(request)
        old = agents.get(conn_id, ident['id'])
        if old['owner'] != ident['id']:
            raise Bad(403, '这是管理员共享的连接，不能修改')
        c = build_connection(await body(request), old, ident)
        agents.save(c)
        log.event(evt='agent_conn', user=ident['name'], action='edit', preset=c['preset'], shared=c['shared'])
        return view(c, ident)

    @router.delete('/connections/{conn_id}')
    @handle
    async def remove(request: Request, conn_id: str):
        ident = who(request)
        agents.delete(conn_id, ident['id'])
        log.event(evt='agent_conn', user=ident['name'], action='delete')
        return {'ok': True}

    @router.post('/connections/models')
    @handle
    async def probe_models(request: Request):
        """表单还没保存时先拉模型列表：按表单内容校验连接（不保存）；编辑时 key 留空用已保存的"""
        ident = who(request)
        values = await body(request)
        if not isinstance(values, dict):
            raise Bad(400, '请求格式不对')
        values = dict(values)
        conn_id = values.pop('id', None)
        old = None
        if conn_id is not None:
            if not isinstance(conn_id, str):
                raise Bad(400, '请求格式不对')
            old = agents.get(conn_id, ident['id'])
            if old['owner'] != ident['id']:
                raise Bad(403, '这是管理员共享的连接，不能修改')
        values.pop('shared', None)
        values.pop('daily_limit', None)
        if not values.get('model'):
            values.pop('model', None)
        return await upstream.models(build_connection(values, old, ident))

    @router.get('/connections/{conn_id}/models')
    @handle
    async def models(request: Request, conn_id: str):
        ident = who(request)
        return await upstream.models(agents.get(conn_id, ident['id']))

    @router.post('/chat')
    @handle
    async def chat(request: Request):
        ident = who(request)
        if int(request.headers.get('content-length') or 0) > MAX_BODY:
            raise Bad(413, '这段对话太大了（图片太多），开个新对话吧')
        b = await body(request, MAX_BODY)
        if not isinstance(b, dict):
            raise Bad(400, '请求格式不对')
        c = agents.get(b.get('conn') if isinstance(b.get('conn'), str) else '', ident['id'])
        model = b.get('model') or c['model']
        if not isinstance(model, str) or not 1 <= len(model) <= 200:
            raise Bad(400, '模型名不对')
        if c['preset'] == 'vertex' and not re.fullmatch(r'[A-Za-z0-9._@-]{1,120}', model):
            raise Bad(400, '模型名格式不对')
        system = b.get('system') or ''
        if not isinstance(system, str) or len(system) > 60000:
            raise Bad(400, '系统提示词太长')
        effort = b.get('effort') or ''
        if effort and effort not in PRESETS[c['preset']].get('efforts', []):
            raise Bad(400, '思考强度不对')
        messages, tools = b.get('messages'), b.get('tools') or []
        check_messages(messages)
        check_tools(tools)
        if active.get(ident['id'], 0) >= 2:
            raise Bad(429, '助手还在回答上一个问题，稍等一下')
        foreign = c['owner'] != ident['id']
        if foreign and not agents.count(ident['id'], c['id'], c.get('daily_limit') or 0):
            raise Bad(429, f'今天用这个共享连接的次数到上限了（{c["daily_limit"]} 次），明天再来，或者添加自己的连接')
        t0 = time.monotonic()
        active[ident['id']] = active.get(ident['id'], 0) + 1
        try:
            resp, parser = await upstream.open_stream(c, model, system, messages, tools, effort)
        except BaseException as e:
            active[ident['id']] -= 1
            if isinstance(e, Bad):
                log.event(evt='agent', user=ident['name'], preset=c['preset'], model=model, status=e.status,
                          dur=round(time.monotonic() - t0, 2))
            raise

        state = {'status': 'ok', 'usage': None, 'closed': False}

        async def close():
            if state['closed']:
                return
            state['closed'] = True
            active[ident['id']] -= 1
            try:
                await resp.aclose()
            finally:
                log.event(evt='agent', user=ident['name'], preset=c['preset'], model=model, effort=effort or None, status=state['status'],
                          dur=round(time.monotonic() - t0, 2), usage=state['usage'], shared=foreign)

        async def gen():
            try:
                async for ev in parser.events(resp):
                    if ev['t'] == 'done':
                        state['usage'] = ev.get('usage')
                    elif ev['t'] == 'error':
                        state['status'] = 'error'
                    yield 'data: ' + json.dumps(ev, ensure_ascii=False) + '\n\n'
            except httpx.HTTPError as e:
                state['status'] = 'broken'
                yield 'data: ' + json.dumps({'t': 'error', 'message': f'和大模型的连接断了：{type(e).__name__}'}, ensure_ascii=False) + '\n\n'
            finally:
                await close()

        return _ClosingStream(gen(), close, media_type='text/event-stream',
                              headers={'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no'})

    return router
