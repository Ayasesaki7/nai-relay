"""每个中转用户自己的云端图库：收藏的图片存在服务器上，换设备也能看到。

目录结构（按 key 的 id 分开，和词库一样）：
    <root>/<user id>/gallery/index.json   相册和图片列表（含生成参数）
    <root>/<user id>/gallery/img/<id>.png  原图
    <root>/<user id>/gallery/thumb/<id>    缩略图（浏览器生成后一起上传）

上传用一个简单的二进制格式，免得多装 multipart 依赖：
    4 字节大端长度 + meta JSON，4 字节大端长度 + 缩略图，剩下的是原图。
"""
import hashlib
import json
import os
import re
import secrets
import struct
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Request
from starlette.responses import FileResponse, JSONResponse

from .management import bearer

MAX_IMAGE = 40 << 20
MAX_THUMB = 1 << 20
MAX_META = 256 << 10
MAX_ITEMS = 20000
MAX_ALBUMS = 200
ID_RE = re.compile(r'[0-9a-f]{16}')


def _error(status, message):
    return JSONResponse({'statusCode': status, 'message': message}, status_code=status)


def image_type(data: bytes):
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png', 'image/png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp', 'image/webp'
    if data[:3] == b'\xff\xd8\xff':
        return 'jpg', 'image/jpeg'
    return None


def _clean_str(v, n):
    return v.strip()[:n] if isinstance(v, str) else ''


def _clean_int(v, lo, hi):
    return v if type(v) is int and lo <= v <= hi else None


class GalleryError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Gallery:
    def __init__(self, root, quota_bytes: int):
        self.root = Path(root)
        self.quota = quota_bytes
        self._lock = threading.Lock()

    # ---------- 存储 ----------

    def _dir(self, user_id: str) -> Path:
        if not re.fullmatch(r'[0-9a-f]{8,64}', user_id or ''):
            raise ValueError('bad id')
        return self.root / user_id / 'gallery'

    def _load(self, d: Path) -> dict:
        f = d / 'index.json'
        if not f.is_file():
            return {'albums': [], 'items': []}
        return json.loads(f.read_text(encoding='utf-8'))

    @staticmethod
    def _atomic(path: Path, data: bytes):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.tmp-')
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _save(self, d: Path, idx: dict):
        self._atomic(d / 'index.json', json.dumps(idx, ensure_ascii=False, separators=(',', ':')).encode())

    @staticmethod
    def _used(idx) -> int:
        return sum(x['size'] + x.get('tsize', 0) for x in idx['items'])

    def _summary(self, idx) -> dict:
        return {'used': self._used(idx), 'quota': self.quota, 'count': len(idx['items'])}

    # ---------- 读 ----------

    def listing(self, user_id: str) -> dict:
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
        return {'albums': idx['albums'], 'items': idx['items'], **self._summary(idx)}

    def file(self, user_id: str, item_id: str, thumb: bool):
        if not ID_RE.fullmatch(item_id or ''):
            return None
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
        it = next((x for x in idx['items'] if x['id'] == item_id), None)
        if not it:
            return None
        if thumb:
            return d / 'thumb' / f'{item_id}.{it["text"]}', it['ttype']
        return d / 'img' / f'{item_id}.{it["ext"]}', it['type']

    # ---------- 写 ----------

    def add(self, user_id: str, meta: dict, thumb: bytes, image: bytes) -> tuple[dict, bool, dict]:
        it_img = image_type(image)
        it_th = image_type(thumb)
        if not it_img or not it_th:
            raise GalleryError(400, '只能保存 PNG / WebP / JPEG 图片')
        sha = hashlib.sha256(image).hexdigest()
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            same = next((x for x in idx['items'] if x['sha'] == sha), None)
            if same:
                return same, True, self._summary(idx)
            if len(idx['items']) >= MAX_ITEMS:
                raise GalleryError(507, f'图库最多 {MAX_ITEMS} 张，先删掉一些')
            if self._used(idx) + len(image) + len(thumb) > self.quota:
                raise GalleryError(507, f'图库空间不够（上限 {self.quota / (1 << 30):.1f} GB），先删掉一些')
            album = _clean_str(meta.get('album'), 32)
            if album and not any(a['id'] == album for a in idx['albums']):
                album = ''
            params = meta.get('params')
            item = {
                'id': secrets.token_hex(8),
                'sha': sha,
                'album': album,
                'created': _clean_int(meta.get('created'), 0, 1 << 53) or int(time.time() * 1000),
                'saved': int(time.time() * 1000),
                'width': _clean_int(meta.get('width'), 1, 65535) or 0,
                'height': _clean_int(meta.get('height'), 1, 65535) or 0,
                'tool': _clean_str(meta.get('tool'), 40),
                'params': params if isinstance(params, dict) else None,
                'ext': it_img[0], 'type': it_img[1], 'size': len(image),
                'text': it_th[0], 'ttype': it_th[1], 'tsize': len(thumb),
            }
            self._atomic(d / 'img' / f'{item["id"]}.{item["ext"]}', image)
            self._atomic(d / 'thumb' / f'{item["id"]}.{item["text"]}', thumb)
            idx['items'].insert(0, item)
            self._save(d, idx)
            return item, False, self._summary(idx)

    def batch(self, user_id: str, op: str, ids, album=None) -> dict:
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise GalleryError(400, '请求格式不对')
        want = set(ids)
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            if op == 'move':
                album = _clean_str(album, 32)
                if album and not any(a['id'] == album for a in idx['albums']):
                    raise GalleryError(404, '相册不存在')
                for x in idx['items']:
                    if x['id'] in want:
                        x['album'] = album
                self._save(d, idx)
            elif op == 'delete':
                gone = [x for x in idx['items'] if x['id'] in want]
                idx['items'] = [x for x in idx['items'] if x['id'] not in want]
                self._save(d, idx)
                for x in gone:
                    for p in (d / 'img' / f'{x["id"]}.{x["ext"]}', d / 'thumb' / f'{x["id"]}.{x["text"]}'):
                        try:
                            p.unlink()
                        except FileNotFoundError:
                            pass
            else:
                raise GalleryError(400, '请求格式不对')
            return self._summary(idx)

    def album(self, user_id: str, op: str, album_id=None, name=None) -> dict:
        d = self._dir(user_id)
        with self._lock:
            idx = self._load(d)
            albums = idx['albums']
            if op in ('create', 'rename'):
                name = _clean_str(name, 40)
                if not name:
                    raise GalleryError(400, '相册名不能为空')
                if any(a['name'].lower() == name.lower() and a['id'] != album_id for a in albums):
                    raise GalleryError(409, '已经有这个相册了')
            if op == 'create':
                if len(albums) >= MAX_ALBUMS:
                    raise GalleryError(400, f'相册最多 {MAX_ALBUMS} 个')
                albums.append({'id': secrets.token_hex(6), 'name': name, 'at': int(time.time() * 1000)})
            else:
                a = next((x for x in albums if x['id'] == album_id), None)
                if not a:
                    raise GalleryError(404, '相册不存在')
                if op == 'rename':
                    a['name'] = name
                else:  # 删相册不删图，图回到「未分组」
                    idx['albums'] = [x for x in albums if x['id'] != album_id]
                    for x in idx['items']:
                        if x['album'] == album_id:
                            x['album'] = ''
            self._save(d, idx)
            return {'albums': idx['albums'], 'album': albums[-1] if op == 'create' else None}


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
        if not isinstance(meta, dict) or len(thumb) != t or not image:
            raise ValueError
    except (ValueError, struct.error, UnicodeDecodeError):
        raise GalleryError(400, '请求格式不对') from None
    if len(image) > MAX_IMAGE:
        raise GalleryError(413, f'单张图片不能超过 {MAX_IMAGE >> 20} MB')
    return meta, thumb, image


def create_gallery_router(store, gallery: Gallery):
    router = APIRouter(prefix='/proxy/gallery')

    def who(request: Request):
        ident = store.identity(bearer(request))
        return ident['id'] if ident else None

    async def json_body(request: Request):
        try:
            body = json.loads(await request.body())
            if not isinstance(body, dict):
                raise ValueError
            return body
        except ValueError:
            raise GalleryError(400, '请求格式不对') from None

    def guarded(fn):
        async def run(request: Request, **kw):
            uid = who(request)
            if not uid:
                return _error(401, 'Invalid proxy key')
            try:
                return await fn(request, uid, **kw)
            except GalleryError as e:
                return _error(e.status, e.message)
        run.__name__ = fn.__name__
        return run

    @router.get('')
    async def listing(request: Request):
        async def go(r, uid):
            return gallery.listing(uid)
        return await guarded(go)(request)

    @router.post('/items')
    async def upload(request: Request):
        async def go(r, uid):
            if int(r.headers.get('content-length') or 0) > MAX_IMAGE + MAX_THUMB + MAX_META + 8:
                raise GalleryError(413, f'单张图片不能超过 {MAX_IMAGE >> 20} MB')
            raw = await r.body()
            meta, thumb, image = parse_upload(raw)
            item, existed, summary = gallery.add(uid, meta, thumb, image)
            return {'item': item, 'existed': existed, **summary}
        return await guarded(go)(request)

    async def send_file(request, item_id, thumb):
        async def go(r, uid):
            found = gallery.file(uid, item_id, thumb)
            if not found or not found[0].is_file():
                raise GalleryError(404, '图片不存在')
            # 图片内容不会变（id 唯一），浏览器可以一直缓存；private 防止中间代理缓存。
            # Vary: Authorization 让浏览器按 key 分开缓存，同一浏览器换人登录拿不到上一个人的缓存
            return FileResponse(found[0], media_type=found[1], headers={
                'Cache-Control': 'private, max-age=31536000, immutable', 'Vary': 'Authorization'})
        return await guarded(go)(request)

    @router.get('/items/{item_id}/image')
    async def image(item_id: str, request: Request):
        return await send_file(request, item_id, False)

    @router.get('/items/{item_id}/thumb')
    async def thumb(item_id: str, request: Request):
        return await send_file(request, item_id, True)

    @router.post('/batch')
    async def batch(request: Request):
        async def go(r, uid):
            b = await json_body(r)
            return gallery.batch(uid, b.get('op'), b.get('ids'), b.get('album'))
        return await guarded(go)(request)

    @router.post('/albums')
    async def album_create(request: Request):
        async def go(r, uid):
            b = await json_body(r)
            return gallery.album(uid, 'create', name=b.get('name'))
        return await guarded(go)(request)

    @router.patch('/albums/{album_id}')
    async def album_rename(album_id: str, request: Request):
        async def go(r, uid):
            b = await json_body(r)
            return gallery.album(uid, 'rename', album_id, b.get('name'))
        return await guarded(go)(request)

    @router.delete('/albums/{album_id}')
    async def album_delete(album_id: str, request: Request):
        async def go(r, uid):
            return gallery.album(uid, 'delete', album_id)
        return await guarded(go)(request)

    return router
