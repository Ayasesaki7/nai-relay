"""每个中转用户自己的小数据（个人词库、提示词快照），存在服务器的数据目录里。

按 key 的 id 分目录（id 不随改名、换 key 变化）。整份文档读写，用 rev 防止
两个设备同时修改时互相覆盖：保存时带上读到的 rev，不一致就返回 409 和最新内容。
"""
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from .management import bearer

KINDS = {'library': 2 << 20, 'snapshots': 4 << 20}  # 每份文档的大小上限（字节）


def _error(status, message, **extra):
    return JSONResponse({'statusCode': status, 'message': message, **extra}, status_code=status)


class UserData:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.Lock()

    def _path(self, user_id: str, kind: str) -> Path:
        if not re.fullmatch(r'[0-9a-f]{8,64}', user_id or '') or kind not in KINDS:
            raise ValueError('bad id')
        return self.root / user_id / f'{kind}.json'

    def read(self, user_id: str, kind: str) -> dict:
        path = self._path(user_id, kind)
        with self._lock:
            if not path.is_file():
                return {'rev': 0, 'updated': None, 'data': None}
            return json.loads(path.read_text(encoding='utf-8'))

    def write(self, user_id: str, kind: str, rev: int, data) -> tuple[bool, dict]:
        path = self._path(user_id, kind)
        with self._lock:
            current = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {'rev': 0, 'updated': None, 'data': None}
            if rev != current['rev']:
                return False, current
            doc = {'rev': current['rev'] + 1, 'updated': int(time.time() * 1000), 'data': data}
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{kind}-')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            return True, doc


def create_userdata_router(store, userdata: UserData):
    router = APIRouter(prefix='/proxy/userdata')

    def who(request: Request):
        ident = store.identity(bearer(request))
        return ident['id'] if ident else None

    @router.get('/{kind}')
    async def get_doc(kind: str, request: Request):
        uid = who(request)
        if not uid:
            return _error(401, 'Invalid proxy key')
        if kind not in KINDS:
            return _error(404, '没有这种数据')
        return userdata.read(uid, kind)

    @router.put('/{kind}')
    async def put_doc(kind: str, request: Request):
        uid = who(request)
        if not uid:
            return _error(401, 'Invalid proxy key')
        if kind not in KINDS:
            return _error(404, '没有这种数据')
        raw = await request.body()
        if len(raw) > KINDS[kind] + 1024:
            return _error(413, f'数据太大（上限 {KINDS[kind] >> 20} MB），删掉一些再保存')
        try:
            body = json.loads(raw)
            rev, data = body['rev'], body['data']
            if type(rev) is not int or not isinstance(data, dict):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return _error(400, '请求格式不对')
        ok, doc = userdata.write(uid, kind, rev, data)
        if not ok:
            return _error(409, '其他设备刚修改过，已载入最新内容', current=doc)
        return {'rev': doc['rev'], 'updated': doc['updated']}

    return router
