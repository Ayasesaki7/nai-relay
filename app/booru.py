"""灵感画廊：从 Danbooru / Safebooru / Gelbooru 搜图，统一成一种格式给网页端。

图片站在国内多半打不开，所以列表和图片都由服务器代取。图片代理只放行这几个站
自己的域名（防止被当成开放代理），而且要带中转 key。
"""
import os
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, StreamingResponse

from .management import bearer

USER_AGENT = 'nai-relay/1.0'
DANBOORU = os.environ.get('DANBOORU_URL', 'https://danbooru.donmai.us').rstrip('/')
SAFEBOORU = os.environ.get('SAFEBOORU_URL', 'https://safebooru.org').rstrip('/')
GELBOORU = os.environ.get('GELBOORU_URL', 'https://gelbooru.com').rstrip('/')
PER_PAGE = 40
MAX_PAGE = 200
MAX_IMAGE = 60 << 20
LIST_TTL = 90
IMAGE_EXT = {'jpg', 'jpeg', 'png', 'webp'}
RATINGS = ('g', 's', 'q', 'e')
RATING_OF = {'g': 'g', 's': 's', 'q': 'q', 'e': 'e', 'general': 'g', 'safe': 'g', 'sensitive': 's',
             'questionable': 'q', 'explicit': 'e'}
# 涉及未成年人的作品一律不显示
BLOCKED = {'loli', 'shota', 'toddler', 'child_on_child', 'underage'}
MODES = ('latest', 'popular', 'random', 'score')
SCALES = ('day', 'week', 'month')
CDN_HOSTS = re.compile(r'^(cdn\.donmai\.us|danbooru\.donmai\.us|safebooru\.org|([a-z0-9-]+\.)?gelbooru\.com)$')


def _error(status, message):
    return JSONResponse({'statusCode': status, 'message': message}, status_code=status)


class BooruError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def gelbooru_auth():
    key, user = os.environ.get('GELBOORU_API_KEY', '').strip(), os.environ.get('GELBOORU_USER_ID', '').strip()
    return {'api_key': key, 'user_id': user} if key and user else None


SOURCES = {
    'danbooru': {'name': 'Danbooru', 'modes': list(MODES), 'max_tags': 2},
    'safebooru': {'name': 'Safebooru', 'modes': ['latest', 'random', 'score'], 'max_tags': 0, 'safe': True},
    'gelbooru': {'name': 'Gelbooru', 'modes': ['latest', 'random', 'score'], 'max_tags': 0},
}


def _split(s):
    return [t for t in (s or '').split() if t]


def _blocked(tags: set) -> bool:
    return bool(tags & BLOCKED)


def norm_danbooru(p: dict):
    ext = (p.get('file_ext') or '').lower()
    if ext not in IMAGE_EXT or not p.get('file_url'):
        return None  # 视频、动图，或者匿名看不到原图的
    groups = {k: _split(p.get(f'tag_string_{k}')) for k in ('artist', 'character', 'copyright', 'general', 'meta')}
    if _blocked(set(_split(p.get('tag_string')))):
        return None
    preview = p.get('preview_file_url')
    for v in (p.get('media_asset') or {}).get('variants') or []:
        if v.get('type') == '360x360' and v.get('url'):
            preview = v['url']
    return {
        'src': 'danbooru', 'id': p['id'], 'w': p.get('image_width') or 0, 'h': p.get('image_height') or 0, 'ext': ext,
        'preview': preview or p.get('large_file_url'), 'sample': p.get('large_file_url') or p['file_url'], 'file': p['file_url'],
        'rating': RATING_OF.get(p.get('rating'), 'q'), 'score': p.get('score') or 0, 'favs': p.get('fav_count') or 0,
        'tags': groups, 'source': p.get('source') or '', 'post': f'https://danbooru.donmai.us/posts/{p["id"]}',
        'created': p.get('created_at') or '',
    }


def norm_gel(p: dict, src: str, base: str):
    image = p.get('image') or ''
    ext = image.rsplit('.', 1)[-1].lower() if '.' in image else ''
    file_url = p.get('file_url') or (f'{base}/images/{p.get("directory")}/{image}' if image else '')
    if ext not in IMAGE_EXT or not file_url:
        return None
    tags = _split(p.get('tags'))
    if _blocked(set(tags)):
        return None
    stem = image.rsplit('.', 1)[0]
    preview = p.get('preview_url') or f'{base}/thumbnails/{p.get("directory")}/thumbnail_{stem}.jpg'
    sample = p.get('sample_url') if p.get('sample') and p.get('sample_url') else file_url
    post = f'https://{"safebooru.org" if src == "safebooru" else "gelbooru.com"}/index.php?page=post&s=view&id={p.get("id")}'
    return {
        'src': src, 'id': p.get('id'), 'w': p.get('width') or 0, 'h': p.get('height') or 0, 'ext': ext,
        'preview': preview, 'sample': sample, 'file': file_url,
        'rating': RATING_OF.get(p.get('rating'), 'q'), 'score': p.get('score') or 0, 'favs': 0,
        'tags': {'artist': [], 'character': [], 'copyright': [], 'general': tags, 'meta': []},
        'source': p.get('source') or '', 'post': post, 'created': str(p.get('created_at') or p.get('change') or ''),
    }


class Booru:
    def __init__(self, get_client):
        self.get_client = get_client
        self.cache = {}

    async def _get(self, url, params):
        try:
            res = await self.get_client().get(url, params=params, headers={'User-Agent': USER_AGENT},
                                              timeout=httpx.Timeout(20, connect=8), follow_redirects=True)
        except httpx.HTTPError:
            raise BooruError(502, '图片站连不上，稍后再试')
        if res.status_code in (401, 403):
            raise BooruError(502, '图片站拒绝了请求（可能需要 API key，或者被限流了）')
        if res.status_code == 422 or res.status_code == 410:
            msg = ''
            try:
                msg = res.json().get('message') or ''
            except ValueError:
                pass
            if 'more than 2 tags' in msg:
                raise BooruError(400, 'Danbooru 匿名搜索最多 2 个 TAG（「随机」「高分」也各算一个），去掉一些再搜')
            if 'beyond page' in msg:
                raise BooruError(400, '已经翻到最后能看的一页了')
            raise BooruError(400, f'搜索条件不对：{msg[:200]}' if msg else '搜索条件不对')
        if res.status_code >= 500 and 'timed out' in res.text[:500]:
            raise BooruError(504, '图片站查询超时：这个 TAG 的图太多，按分数排不过来。换个更具体的 TAG，或者用「最新」「随机」')
        if res.status_code >= 400:
            raise BooruError(502, f'图片站返回错误 {res.status_code}')
        if not res.content.strip():
            return []
        try:
            return res.json()
        except ValueError:
            raise BooruError(502, '图片站返回的内容看不懂')

    async def posts(self, src, tags, page, mode, scale, ratings, date=None):
        key = (src, tags, page, mode, scale, ratings, date)
        hit = self.cache.get(key)
        if hit and time.time() - hit[0] < LIST_TTL and mode != 'random':
            return hit[1]
        words = _split(tags)
        rated = set(ratings) != set(RATINGS)
        if src == 'danbooru':
            if mode == 'popular' and not words:
                d = date or (datetime.now(timezone.utc) - timedelta(hours=6)).strftime('%Y-%m-%d')
                raw = await self._get(f'{DANBOORU}/explore/posts/popular.json', {'date': d, 'scale': scale, 'page': page})
            else:
                q = list(words)
                if mode == 'score':
                    q.append('order:score')
                elif mode == 'popular':
                    q.append('order:rank')
                if rated:
                    q.append('rating:' + ','.join(ratings))
                params = {'tags': ' '.join(q), 'page': page, 'limit': PER_PAGE}
                if mode == 'random':
                    params['random'] = 'true'
                raw = await self._get(f'{DANBOORU}/posts.json', params)
            items = [norm_danbooru(p) for p in raw if isinstance(p, dict) and p.get('id')] if isinstance(raw, list) else []
        else:
            base = SAFEBOORU if src == 'safebooru' else GELBOORU
            q = list(words)
            if mode == 'random':
                q.append('sort:random')
            elif mode in ('score', 'popular'):
                q.append('sort:score:desc')
            params = {'page': 'dapi', 's': 'post', 'q': 'index', 'json': 1, 'limit': PER_PAGE, 'pid': page - 1, 'tags': ' '.join(q)}
            if src == 'gelbooru':
                auth = gelbooru_auth()
                if not auth:
                    raise BooruError(400, 'Gelbooru 需要 API key：在服务器 .env 里填 GELBOORU_API_KEY 和 GELBOORU_USER_ID')
                params.update(auth)
            raw = await self._get(f'{base}/index.php', params)
            if isinstance(raw, dict):
                raw = raw.get('post') or []
            if isinstance(raw, dict):
                raw = [raw]
            items = [norm_gel(p, src, base) for p in raw if isinstance(p, dict) and p.get('id')] if isinstance(raw, list) else []
        got = len(raw) if isinstance(raw, list) else 0
        items = [x for x in items if x and x['rating'] in ratings]
        out = {'items': items, 'page': page, 'more': got > 0 and page < MAX_PAGE and (mode == 'random' or got >= PER_PAGE // 2)}
        if len(self.cache) > 300:
            self.cache.clear()
        self.cache[key] = (time.time(), out)
        return out


def _allowed(url: str) -> bool:
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    if u.username or u.password or not u.hostname:
        return False
    host = u.hostname.lower()
    if u.scheme == 'https' and CDN_HOSTS.match(host):
        return True
    # 配置的站点地址（测试时是本地的模拟站）
    for base in (DANBOORU, SAFEBOORU, GELBOORU):
        b = urlsplit(base)
        if b.hostname and host == b.hostname.lower() and u.scheme == b.scheme and u.port == b.port:
            return True
    return False


def create_booru_router(store, booru: Booru):
    router = APIRouter(prefix='/proxy/booru')

    def authed(request: Request):
        return bool(store.identity(bearer(request)))

    @router.get('/sources')
    async def sources(request: Request):
        if not authed(request):
            return _error(401, 'Invalid proxy key')
        return {'items': [{'id': k, **v, 'ready': k != 'gelbooru' or bool(gelbooru_auth())} for k, v in SOURCES.items()]}

    @router.get('/posts')
    async def posts(request: Request, src: str = 'danbooru', tags: str = '', page: int = 1, mode: str = 'latest',
                    scale: str = 'day', rating: str = 'g,s', date: str = ''):
        if not authed(request):
            return _error(401, 'Invalid proxy key')
        if src not in SOURCES or mode not in SOURCES[src]['modes'] or scale not in SCALES:
            return _error(400, '参数不对')
        ratings = tuple(r for r in RATINGS if r in rating.split(','))
        if not ratings:
            return _error(400, '至少选一个分级')
        if not re.fullmatch(r'(\d{4}-\d{2}-\d{2})?', date):
            return _error(400, '日期格式不对')
        tags = ' '.join(_split(tags[:300]))
        try:
            return await booru.posts(src, tags, max(1, min(page, MAX_PAGE)), mode, scale, ratings, date or None)
        except BooruError as e:
            return _error(e.status, e.message)

    @router.get('/image')
    async def image(request: Request, u: str):
        if not authed(request):
            return _error(401, 'Invalid proxy key')
        if len(u) > 1000 or not _allowed(u):
            return _error(400, '不支持的图片地址')
        client = booru.get_client()
        try:
            req = client.build_request('GET', u, headers={'User-Agent': USER_AGENT}, timeout=httpx.Timeout(60, connect=10))
            res = await client.send(req, stream=True, follow_redirects=False)
        except httpx.HTTPError:
            return _error(502, '图片站连不上')
        ctype = res.headers.get('content-type', '').split(';')[0].strip().lower()
        size = int(res.headers.get('content-length') or 0)
        problem = (502, f'图片取不到（{res.status_code}）') if res.status_code != 200 else (
            (502, '对方返回的不是图片') if not ctype.startswith('image/') else (413, '图片太大') if size > MAX_IMAGE else None)
        if problem:
            await res.aclose()
            return _error(*problem)

        async def body():
            sent = 0
            try:
                async for chunk in res.aiter_bytes():
                    sent += len(chunk)
                    if sent > MAX_IMAGE:
                        break
                    yield chunk
            finally:
                await res.aclose()

        headers = {'Cache-Control': 'private, max-age=86400', 'Vary': 'Authorization'}
        if size:
            headers['Content-Length'] = str(size)
        return StreamingResponse(body(), media_type=ctype, headers=headers)

    return router


__all__ = ['Booru', 'create_booru_router', 'BooruError', 'norm_danbooru', 'norm_gel']
