"""TAG 检索：本地中英词库 + Danbooru 的别名 / 相关 TAG。

词库来自 ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table（MIT），
是一个 SQLite 文件：tags(name, category, cn_name, post_count)。
服务启动后在后台下载到数据目录，之后每天更新一次；下载失败就继续用旧文件。
"""
import asyncio
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request

from .management import bearer

DICT_URL = os.environ.get(
    'TAG_DICT_URL',
    'https://raw.githubusercontent.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/main/tag.sqlite')
DICT_FILE = Path(os.environ.get('TAG_DICT_FILE', '/app/data/tags.sqlite'))
DICT_MAX_AGE = 24 * 3600
DANBOORU = os.environ.get('DANBOORU_URL', 'https://danbooru.donmai.us').rstrip('/')
USER_AGENT = 'nai-relay/1.0'
CATEGORIES = {0, 1, 3, 4, 5}
CACHE_TTL = 6 * 3600
CACHE_MAX = 500

_CJK = re.compile(r'[぀-ヿ㐀-鿿豈-﫿]')


def normalize(name: str) -> str:
    """提示词里的写法 → Danbooru 的写法：小写、空格换下划线、去掉权重符号。"""
    name = re.sub(r'^-?\d+(\.\d+)?::|::$', '', name.strip())
    name = name.strip('{}[] ').lower()
    return re.sub(r'\s+', '_', name)


def _escape_like(s: str) -> str:
    return s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _row(r) -> dict:
    return {'name': r[0], 'cat': r[1], 'cn': r[2] or '', 'count': r[3] or 0}


class TagDict:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._conn = None
        self._lock = threading.Lock()
        self.loaded_at = 0.0
        self.count = 0
        self.error = ''

    # ---------- 文件 ----------

    def open(self) -> bool:
        """（重新）打开词库文件；文件不存在或损坏返回 False。"""
        if not self.path.is_file():
            return False
        try:
            conn = sqlite3.connect(f'file:{self.path.as_posix()}?mode=ro', uri=True, check_same_thread=False)
            count = conn.execute('SELECT count(*) FROM tags').fetchone()[0]
        except sqlite3.Error as e:
            self.error = f'词库文件损坏：{e}'
            return False
        with self._lock:
            old, self._conn = self._conn, conn
            self.count = count
            self.loaded_at = self.path.stat().st_mtime
        if old:
            old.close()
        return True

    @property
    def ready(self) -> bool:
        return self._conn is not None

    def stale(self) -> bool:
        return not self.path.is_file() or time.time() - self.path.stat().st_mtime > DICT_MAX_AGE

    async def download(self, client: httpx.AsyncClient) -> None:
        tmp = self.path.with_suffix('.download')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            async with client.stream('GET', DICT_URL, headers={'User-Agent': USER_AGENT}) as res:
                res.raise_for_status()
                with open(tmp, 'wb') as f:
                    async for chunk in res.aiter_bytes(1 << 16):
                        f.write(chunk)
            # 先确认新文件能用，再替换旧文件
            check = sqlite3.connect(f'file:{tmp.as_posix()}?mode=ro', uri=True)
            try:
                n = check.execute('SELECT count(*) FROM tags WHERE name = ?', ('1girl',)).fetchone()[0]
            finally:
                check.close()
            if n != 1:
                raise ValueError('下载的词库内容不对')
            os.replace(tmp, self.path)
            self.error = ''
        except Exception as e:  # noqa: BLE001 —— 下载失败就继续用旧词库
            self.error = f'词库更新失败：{type(e).__name__}: {e}'[:300]
            tmp.unlink(missing_ok=True)
            return
        self.open()

    # ---------- 查询 ----------

    def _query(self, sql: str, args) -> list:
        with self._lock:
            conn = self._conn
            if conn is None:
                return []
            return conn.execute(sql, args).fetchall()

    def search(self, q: str, cat: int | None = None, limit: int = 40) -> list[dict]:
        q = q.strip()
        if not q:
            return []
        if not _CJK.search(q):
            q = normalize(q)
            if not q:
                return []
        e = _escape_like(q)
        # 排序：完全一致 > 开头或某个单词开头一致 > 其他位置包含；同一档按热度
        sql = r'''
            SELECT name, category, cn_name, post_count,
                   CASE WHEN name = :q OR cn_name = :q THEN 0
                        WHEN name LIKE :p ESCAPE '\' OR name LIKE :w ESCAPE '\' OR cn_name LIKE :p ESCAPE '\' THEN 1
                        ELSE 2 END AS rank
            FROM tags
            WHERE (name LIKE :c ESCAPE '\' OR cn_name LIKE :c ESCAPE '\')''' + (' AND category = :cat' if cat is not None else '') + '''
            ORDER BY rank, post_count DESC
            LIMIT :n'''
        rows = self._query(sql, {'q': q, 'p': e + '%', 'w': '%\\_' + e + '%', 'c': '%' + e + '%', 'cat': cat, 'n': limit})
        return [_row(r) for r in rows]

    def lookup(self, names: list[str]) -> dict:
        keys = {normalize(n): n for n in names if n and n.strip()}
        if not keys:
            return {}
        marks = ','.join('?' * len(keys))
        rows = self._query(f'SELECT name, category, cn_name, post_count FROM tags WHERE name IN ({marks})', list(keys))
        return {r[0]: _row(r) for r in rows}


class _TTLCache:
    def __init__(self):
        self.data = {}

    def get(self, key):
        hit = self.data.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
        return None

    def put(self, key, value):
        if len(self.data) >= CACHE_MAX:
            for k in sorted(self.data, key=lambda k: self.data[k][0])[: CACHE_MAX // 5]:
                del self.data[k]
        self.data[key] = (time.time(), value)


def create_tag_router(store, tags: TagDict, get_client):
    router = APIRouter(prefix='/proxy/tags')
    cache = _TTLCache()

    def auth(request: Request):
        if not store.identity(bearer(request)):
            raise HTTPException(401, '中转 Key 无效或已停用')

    def status():
        return {'ready': tags.ready, 'count': tags.count, 'updated': int(tags.loaded_at) or None, 'error': tags.error or None}

    async def danbooru(path: str, params: dict):
        res = await get_client().get(f'{DANBOORU}{path}', params=params, headers={'User-Agent': USER_AGENT},
                                     timeout=httpx.Timeout(15, connect=8))
        res.raise_for_status()
        return res.json()

    @router.get('/search')
    async def search(request: Request, q: str = '', cat: int | None = None, limit: int = 40):
        auth(request)
        if cat is not None and cat not in CATEGORIES:
            raise HTTPException(400, '分类不对')
        items = await asyncio.to_thread(tags.search, q[:100], cat, max(1, min(limit, 100)))
        return {**status(), 'items': items}

    @router.post('/lookup')
    async def lookup(request: Request):
        auth(request)
        try:
            body = await request.json()
            names = [str(n)[:200] for n in body.get('names', [])][:300]
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, '请求格式不对')
        return {'ready': tags.ready, 'items': await asyncio.to_thread(tags.lookup, names)}

    @router.get('/detail')
    async def detail(request: Request, name: str):
        auth(request)
        name = normalize(name)[:200]
        if not name:
            raise HTTPException(400, '缺少 TAG')
        hit = cache.get(name)
        if hit is None:
            hit = {'aliases': [], 'other_names': [], 'alias_of': None, 'related': [], 'remote_error': None}
            results = await asyncio.gather(
                danbooru('/related_tag.json', {'query': name, 'limit': 40}),
                danbooru('/tag_aliases.json', {'search[consequent_name]': name, 'limit': 100}),
                danbooru('/tag_aliases.json', {'search[antecedent_name]': name, 'limit': 5}),
                danbooru(f"/wiki_pages/{quote(name, safe='')}.json", {'only': 'other_names,is_deleted'}),
                return_exceptions=True)
            rel, alias_in, alias_out, wiki = results
            errors = [r for r in (rel, alias_in, alias_out) if isinstance(r, Exception)]
            if isinstance(rel, dict):
                for item in rel.get('related_tags') or []:
                    t = item.get('tag') or {}
                    if t.get('name') and t['name'] != name:
                        hit['related'].append({'name': t['name'], 'cat': t.get('category', 0), 'count': t.get('post_count', 0)})
            if isinstance(alias_in, list):
                hit['aliases'] = [a['antecedent_name'] for a in alias_in if a.get('status') == 'active' and a.get('antecedent_name')][:30]
            if isinstance(alias_out, list):
                hit['alias_of'] = next((a['consequent_name'] for a in alias_out if a.get('status') == 'active'), None)
            if isinstance(wiki, dict) and not wiki.get('is_deleted'):
                hit['other_names'] = [str(n) for n in wiki.get('other_names') or []][:30]
            if errors:
                hit['remote_error'] = 'Danbooru 暂时连不上，相关 TAG 和别名可能不全'
            else:
                cache.put(name, hit)
        info = await asyncio.to_thread(tags.lookup, [name] + [r['name'] for r in hit['related']] + ([hit['alias_of']] if hit['alias_of'] else []))
        related = [{**r, 'cn': info.get(r['name'], {}).get('cn', '')} for r in hit['related']]
        alias_of = hit['alias_of']
        return {**hit, 'related': related, 'tag': info.get(name),
                'alias_of': info.get(alias_of) or ({'name': alias_of, 'cat': 0, 'cn': '', 'count': 0} if alias_of else None)}

    @router.get('/status')
    async def get_status(request: Request):
        auth(request)
        return status()

    return router


async def keep_updated(tags: TagDict, stop: asyncio.Event):
    """后台任务：启动时打开已有词库；过期或没有就下载，之后每小时检查一次。"""
    tags.open()
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=20), follow_redirects=True) as client:
        while not stop.is_set():
            if DICT_URL and tags.stale():  # TAG_DICT_URL 设成空就不自动下载
                await tags.download(client)
            try:
                await asyncio.wait_for(stop.wait(), timeout=3600)
            except asyncio.TimeoutError:
                pass
