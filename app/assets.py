"""每个中转用户自己的参考素材库：氛围参考（Vibe）和角色参考图，存在服务器上。

和云端图库放在同一个用户目录下：
    <root>/<user id>/assets/index.json          素材列表（名称、分类、默认参数、已有的编码）
    <root>/<user id>/assets/img/<id>.<ext>      原图（只导入了编码的氛围没有原图）
    <root>/<user id>/assets/thumb/<id>.<ext>    缩略图
    <root>/<user id>/assets/enc/<id>-<key>.bin  氛围编码（encode-vibe 的结果，按 模型+信息量 分）

氛围编码每次要花 2 Anlas，存到服务器后换电脑、换浏览器也不用重新编码。
上传格式和图库一样：4 字节长度 + meta JSON，4 字节长度 + 缩略图，剩下是原图（可以为空）。
"""
import base64
import binascii
import hashlib
import re
import secrets
import struct
import json
import time
from pathlib import Path

from fastapi import APIRouter, Request
from starlette.responses import FileResponse, JSONResponse

from .gallery import Gallery, GalleryError, image_type, _clean_str, _clean_int, MAX_IMAGE, MAX_THUMB, ID_RE
from .management import bearer

MAX_META = 32 << 20  # 导入时编码放在 meta 里
MAX_ENCODING = 8 << 20
MAX_ENCODINGS = 16  # 每个素材最多存几份编码（不同模型 / 信息量）
MAX_ITEMS = 5000
KINDS = ('vibe', 'ref')
REF_TYPES = ('character', 'style', 'character&style')
MODEL_RE = re.compile(r'nai-diffusion-[a-z0-9-]{1,40}')


def _error(status, message):
    return JSONResponse({'statusCode': status, 'message': message}, status_code=status)


def _unit(v, lo=0.0, default=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= 1:
        return default
    return round(float(v), 2)


def clean_params(kind, p):
    p = p if isinstance(p, dict) else {}
    if kind == 'vibe':
        return {'strength': _unit(p.get('strength'), 0, 0.6), 'info': _unit(p.get('info'), 0.01, 1.0)}
    return {
        'type': p.get('type') if p.get('type') in REF_TYPES else 'character&style',
        'strength': _unit(p.get('strength'), 0, 1.0),
        'fidelity': _unit(p.get('fidelity'), 0, 0.8),
    }


def enc_key(model, info):
    """(模型, 信息量) → 合法的 (model, info, 文件名片段)；不合法返回 None"""
    if not isinstance(model, str) or not MODEL_RE.fullmatch(model):
        return None
    try:
        info = round(float(info), 2)
    except (TypeError, ValueError):
        return None
    if not 0.01 <= info <= 1:
        return None
    return model, info, hashlib.sha1(f'{model}:{info:.2f}'.encode()).hexdigest()[:12]


class Assets(Gallery):
    def _dir(self, user_id: str) -> Path:
        if not re.fullmatch(r'[0-9a-f]{8,64}', user_id or ''):
            raise ValueError('bad id')
        return self.root / user_id / 'assets'

    def _load(self, d: Path) -> dict:
        f = d / 'index.json'
        if not f.is_file():
            return {'items': []}
        return json.loads(f.read_text(encoding='utf-8'))

    @staticmethod
    def _used(idx) -> int:
        return sum(x['size'] + x['tsize'] + sum(e['size'] for e in x['encodings']) for x in idx['items'])

    def listing(self, user_id: str) -> dict:
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
        return {'items': idx['items'], **self._summary(idx)}

    def _find(self, idx, item_id):
        return next((x for x in idx['items'] if x['id'] == item_id), None) if ID_RE.fullmatch(item_id or '') else None

    def file(self, user_id: str, item_id: str, thumb: bool):
        d = self._dir(user_id)
        with self._lock:
            it = self._find(self._load(d), item_id)
        if not it:
            return None
        if thumb:
            return (d / 'thumb' / f'{item_id}.{it["text"]}', it['ttype']) if it['tsize'] else None
        return (d / 'img' / f'{item_id}.{it["ext"]}', it['type']) if it['size'] else None

    def _check_space(self, idx, extra):
        if self._used(idx) + extra > self.quota:
            raise GalleryError(507, f'素材库空间不够（上限 {self.quota / (1 << 20):.0f} MB），先删掉一些')

    # ---------- 新增 ----------

    def add(self, user_id: str, meta: dict, thumb: bytes, image: bytes):
        kind = meta.get('kind')
        if kind not in KINDS:
            raise GalleryError(400, '请求格式不对')
        encs = []
        for e in meta.get('encodings') or []:
            k = enc_key(e.get('model'), e.get('info')) if isinstance(e, dict) else None
            try:
                data = base64.b64decode(e.get('data') or '', validate=True) if k else b''
            except (binascii.Error, ValueError, TypeError):
                data = b''
            if not k or not data or len(data) > MAX_ENCODING:
                raise GalleryError(400, '氛围编码格式不对')
            if all(x[0][2] != k[2] for x in encs):
                encs.append((k, data))
        if kind == 'ref':
            encs = []
        encs = encs[:MAX_ENCODINGS]
        it_img = image_type(image) if image else None
        it_th = image_type(thumb) if thumb else None
        if (image and not it_img) or (thumb and not it_th):
            raise GalleryError(400, '只能保存 PNG / WebP / JPEG 图片')
        if not image and not encs:
            raise GalleryError(400, '没有图片' if kind == 'ref' else '没有图片也没有编码')
        sha = hashlib.sha256(image or encs[0][1]).hexdigest()
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            same = next((x for x in idx['items'] if x['sha'] == sha and x['kind'] == kind), None)
            if same:
                return same, True, self._summary(idx)
            if len(idx['items']) >= MAX_ITEMS:
                raise GalleryError(507, f'素材库最多 {MAX_ITEMS} 个，先删掉一些')
            self._check_space(idx, len(image) + len(thumb) + sum(len(e[1]) for e in encs))
            item = {
                'id': secrets.token_hex(8),
                'kind': kind,
                'sha': sha,
                'name': _clean_str(meta.get('name'), 60),
                'category': _clean_str(meta.get('category'), 30),
                'created': int(time.time() * 1000),
                'width': _clean_int(meta.get('width'), 1, 65535) or 0,
                'height': _clean_int(meta.get('height'), 1, 65535) or 0,
                'params': clean_params(kind, meta.get('params')),
                'ext': it_img[0] if it_img else '', 'type': it_img[1] if it_img else '', 'size': len(image),
                'text': it_th[0] if it_th else '', 'ttype': it_th[1] if it_th else '', 'tsize': len(thumb),
                'encodings': [],
            }
            if image:
                self._atomic(d / 'img' / f'{item["id"]}.{item["ext"]}', image)
            if thumb:
                self._atomic(d / 'thumb' / f'{item["id"]}.{item["text"]}', thumb)
            for (model, info, key), data in encs:
                self._atomic(d / 'enc' / f'{item["id"]}-{key}.bin', data)
                item['encodings'].append({'model': model, 'info': info, 'size': len(data)})
            idx['items'].insert(0, item)
            self._save(d, idx)
            return item, False, self._summary(idx)

    # ---------- 编码 ----------

    def encoding(self, user_id: str, item_id: str, model, info):
        k = enc_key(model, info)
        if not k:
            return None
        d = self._dir(user_id)
        with self._lock:
            it = self._find(self._load(d), item_id)
        if not it or not any(e['model'] == k[0] and e['info'] == k[1] for e in it['encodings']):
            return None
        return d / 'enc' / f'{item_id}-{k[2]}.bin'

    def put_encoding(self, user_id: str, item_id: str, model, info, data: bytes):
        k = enc_key(model, info)
        if not k or not data or len(data) > MAX_ENCODING:
            raise GalleryError(400, '氛围编码格式不对')
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            it = self._find(idx, item_id)
            if not it or it['kind'] != 'vibe':
                raise GalleryError(404, '素材不存在')
            old = next((e for e in it['encodings'] if e['model'] == k[0] and e['info'] == k[1]), None)
            if old:
                return it, self._summary(idx)
            if len(it['encodings']) >= MAX_ENCODINGS:  # 挤掉最早的一份
                gone = it['encodings'].pop(0)
                (d / 'enc' / f'{item_id}-{enc_key(gone["model"], gone["info"])[2]}.bin').unlink(missing_ok=True)
            self._check_space(idx, len(data))
            self._atomic(d / 'enc' / f'{item_id}-{k[2]}.bin', data)
            it['encodings'].append({'model': k[0], 'info': k[1], 'size': len(data)})
            self._save(d, idx)
            return it, self._summary(idx)

    # ---------- 修改 ----------

    def update(self, user_id: str, item_id: str, body: dict):
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            it = self._find(idx, item_id)
            if not it:
                raise GalleryError(404, '素材不存在')
            if 'name' in body:
                it['name'] = _clean_str(body['name'], 60)
            if 'category' in body:
                it['category'] = _clean_str(body['category'], 30)
            if 'params' in body:
                it['params'] = clean_params(it['kind'], {**it['params'], **(body['params'] if isinstance(body['params'], dict) else {})})
            self._save(d, idx)
            return it

    def batch(self, user_id: str, op: str, ids, category=None) -> dict:
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise GalleryError(400, '请求格式不对')
        want = set(ids)
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            if op == 'move':
                category = _clean_str(category, 30)
                for x in idx['items']:
                    if x['id'] in want:
                        x['category'] = category
                self._save(d, idx)
            elif op == 'delete':
                gone = [x for x in idx['items'] if x['id'] in want]
                idx['items'] = [x for x in idx['items'] if x['id'] not in want]
                self._save(d, idx)
                for x in gone:
                    paths = [d / 'img' / f'{x["id"]}.{x["ext"]}', d / 'thumb' / f'{x["id"]}.{x["text"]}']
                    paths += [d / 'enc' / f'{x["id"]}-{enc_key(e["model"], e["info"])[2]}.bin' for e in x['encodings']]
                    for p in paths:
                        if p.is_file():
                            p.unlink()
            else:
                raise GalleryError(400, '请求格式不对')
            return self._summary(idx)


def parse_upload(raw: bytes):
    try:
        (n,) = struct.unpack('>I', raw[:4])
        if n > MAX_META:
            raise ValueError
        meta = json.loads(raw[4:4 + n])
        (t,) = struct.unpack('>I', raw[4 + n:8 + n])
        if t > MAX_THUMB:
            raise ValueError
        thumb = raw[8 + n:8 + n + t]
        image = raw[8 + n + t:]
        if not isinstance(meta, dict) or len(thumb) != t:
            raise ValueError
    except (ValueError, struct.error, UnicodeDecodeError):
        raise GalleryError(400, '请求格式不对') from None
    if len(image) > MAX_IMAGE:
        raise GalleryError(413, f'单张图片不能超过 {MAX_IMAGE >> 20} MB')
    return meta, thumb, image


def create_assets_router(store, assets: Assets):
    router = APIRouter(prefix='/proxy/assets')

    async def json_body(request: Request):
        try:
            body = json.loads(await request.body())
            if not isinstance(body, dict):
                raise ValueError
            return body
        except ValueError:
            raise GalleryError(400, '请求格式不对') from None

    async def run(request: Request, fn):
        ident = store.identity(bearer(request))
        if not ident:
            return _error(401, 'Invalid proxy key')
        try:
            return await fn(ident['id'])
        except GalleryError as e:
            return _error(e.status, e.message)

    def send(path, media_type, immutable=True):
        if not path or not Path(path).is_file():
            raise GalleryError(404, '文件不存在')
        return FileResponse(path, media_type=media_type, headers={
            'Cache-Control': 'private, max-age=31536000, immutable' if immutable else 'private, no-cache',
            'Vary': 'Authorization'})

    @router.get('')
    async def listing(request: Request):
        async def go(uid):
            return assets.listing(uid)
        return await run(request, go)

    @router.post('/items')
    async def upload(request: Request):
        async def go(uid):
            if int(request.headers.get('content-length') or 0) > MAX_IMAGE + MAX_THUMB + MAX_META + 8:
                raise GalleryError(413, '文件太大了')
            meta, thumb, image = parse_upload(await request.body())
            item, existed, summary = assets.add(uid, meta, thumb, image)
            return {'item': item, 'existed': existed, **summary}
        return await run(request, go)

    @router.get('/items/{item_id}/image')
    async def image(item_id: str, request: Request):
        async def go(uid):
            found = assets.file(uid, item_id, False)
            return send(*(found or (None, None)))
        return await run(request, go)

    @router.get('/items/{item_id}/thumb')
    async def thumb(item_id: str, request: Request):
        async def go(uid):
            found = assets.file(uid, item_id, True)
            return send(*(found or (None, None)))
        return await run(request, go)

    @router.get('/items/{item_id}/encoding')
    async def get_encoding(item_id: str, request: Request, model: str = '', info: str = ''):
        async def go(uid):
            return send(assets.encoding(uid, item_id, model, info), 'application/octet-stream')
        return await run(request, go)

    @router.put('/items/{item_id}/encoding')
    async def put_encoding(item_id: str, request: Request, model: str = '', info: str = ''):
        async def go(uid):
            if int(request.headers.get('content-length') or 0) > MAX_ENCODING:
                raise GalleryError(413, '编码太大了')
            item, summary = assets.put_encoding(uid, item_id, model, info, await request.body())
            return {'item': item, **summary}
        return await run(request, go)

    @router.patch('/items/{item_id}')
    async def update(item_id: str, request: Request):
        async def go(uid):
            return {'item': assets.update(uid, item_id, await json_body(request))}
        return await run(request, go)

    @router.post('/batch')
    async def batch(request: Request):
        async def go(uid):
            b = await json_body(request)
            return assets.batch(uid, b.get('op'), b.get('ids'), b.get('category'))
        return await run(request, go)

    return router
