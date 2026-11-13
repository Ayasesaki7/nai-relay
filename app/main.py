import asyncio
import hashlib
import json
import os
import random
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse

from . import config
from . import logger as log
from .control import ControlStore
from .management import bearer, create_router
from .tags import TagDict, create_tag_router, keep_updated, DICT_FILE
from .userdata import UserData, create_userdata_router
from .gallery import Gallery, create_gallery_router
from .assets import Assets, create_assets_router
from .booru import Booru, create_booru_router
from .agent import AgentStore, Upstream, create_agent_router

IMAGE = config.IMAGE_UPSTREAM
API = config.API_UPSTREAM

# 白名单：只放行生图和只读的账号信息接口，其余（改密码、改 token、文本生成等）一律拒绝
# 2026-08 起 NAI 把 /user/* 挪到了 image 域名，api 域名会返回 400 "update to the image URL"
ROUTES: dict[tuple[str, str], str] = {
    ("POST", "/ai/generate-image"): IMAGE,
    ("POST", "/ai/generate-image-stream"): IMAGE,
    ("POST", "/ai/augment-image"): IMAGE,
    ("POST", "/ai/encode-vibe"): IMAGE,
    ("GET", "/ai/generate-image/suggest-tags"): IMAGE,
    ("POST", "/ai/upscale"): IMAGE,  # 2026-11 起 api 域名返回 404 "Cannot POST /ai/upscale"
    ("POST", "/ai/annotate-image"): API,
    ("GET", "/user/subscription"): IMAGE,
    ("GET", "/user/data"): IMAGE,
    ("GET", "/user/priority"): IMAGE,
    ("GET", "/user/information"): IMAGE,
}

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# 透传给客户端的响应头，其余（set-cookie、cf-*、content-encoding 等）丢掉
PASS_RESPONSE_HEADERS = ("content-type", "content-disposition")

MAX_BODY = int(config.MAX_BODY_MB * 1024 * 1024)


class GenQueue:
    """全局串行队列：同一时间只有一个生成请求在跑，前后两次之间留随机间隔。"""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._last_done = 0.0
        self.waiting = 0

    async def acquire(self) -> float:
        start = time.monotonic()
        self.waiting += 1
        try:
            await asyncio.wait_for(self._lock.acquire(), config.QUEUE_TIMEOUT)
        finally:
            self.waiting -= 1
        try:
            gap = self._last_done + config.MIN_INTERVAL + random.uniform(0, config.JITTER) - time.monotonic()
            if gap > 0:
                await asyncio.sleep(gap)
        except BaseException:
            self._lock.release()
            raise
        return time.monotonic() - start

    def release(self) -> None:
        self._last_done = time.monotonic()
        self._lock.release()


class ClosingStreamingResponse(StreamingResponse):
    """客户端中途断开时 Starlette 不会关闭 body 迭代器，这里保证一定关闭，从而释放队列。"""

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.body_iterator.aclose()


queue = GenQueue()
control = ControlStore(os.environ.get('CONTROL_FILE', '/app/data/control.json'), config.NAI_TOKEN, config.PROXY_KEYS)
client: httpx.AsyncClient
tag_dict = TagDict(DICT_FILE)
user_data = UserData(os.environ.get('USER_DATA_DIR') or Path(control.path).parent / 'users')
gallery = Gallery(user_data.root, int(os.environ.get('GALLERY_QUOTA_MB') or 5120) << 20)
assets = Assets(user_data.root, int(os.environ.get('ASSET_QUOTA_MB') or 1024) << 20)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    control.load()
    log.setup()
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(config.UPSTREAM_TIMEOUT, connect=15),
        follow_redirects=False,
    )
    log.event(evt="startup", users=sorted(config.PROXY_KEYS.values()))
    stop = asyncio.Event()
    updater = asyncio.create_task(keep_updated(tag_dict, stop))
    try:
        yield
    finally:
        stop.set()
        updater.cancel()
        await client.aclose()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
# 有些第三方工具是网页版，需要 CORS；鉴权靠 key，所以 origin 放开没问题
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(create_router(control, lambda: client,
                                lambda: {'busy': queue._lock.locked(), 'waiting': queue.waiting}))
app.include_router(create_tag_router(control, tag_dict, lambda: client))
app.include_router(create_userdata_router(control, user_data))
app.include_router(create_gallery_router(control, gallery))
app.include_router(create_assets_router(control, assets))
app.include_router(create_booru_router(control, Booru(lambda: client)))
agent_store = AgentStore(os.environ.get('AGENT_FILE') or Path(control.path).parent / 'agent.json')
app.include_router(create_agent_router(control, agent_store, Upstream(lambda: client), user_data))


def _error(status: int, message: str) -> JSONResponse:
    # 和 NAI 的错误格式保持一致，第三方工具能正常显示
    return JSONResponse({"statusCode": status, "message": message}, status_code=status)


def _client_ip(request: Request) -> str:
    # 服务只通过 Caddy 暴露，X-Forwarded-For 由 Caddy 写入，可信
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "-"


def _authenticate(request: Request) -> str | None:
    identity = control.identity(bearer(request))
    return identity['name'] if identity else None


def _summarize(body: bytes, content_type: str) -> dict:
    """从生图请求里抽出关键参数写日志，不记录图片 base64。"""
    if "json" not in content_type or not body:
        return {}
    try:
        data = json.loads(body)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    params = data.get("parameters")
    if not isinstance(params, dict):
        params = {}

    info = {}
    for k in ("model", "action", "req_type"):
        if data.get(k) is not None:
            info[k] = data[k]
    for k in ("width", "height", "steps", "scale", "sampler", "n_samples", "seed", "strength"):
        v = params.get(k, data.get(k))
        if isinstance(v, (int, float, str)):
            info[k] = v
    if config.LOG_PROMPT:
        prompt = data.get("input")
        if isinstance(prompt, str):
            info["prompt"] = prompt[: config.LOG_PROMPT_MAX]
        negative = params.get("negative_prompt")
        if isinstance(negative, str) and negative:
            info["negative"] = negative[: config.LOG_PROMPT_MAX]
    return info


@app.get("/healthz")
async def healthz():
    return {"ok": True, "queue_waiting": queue.waiting}


@app.get("/proxy/me")
async def me(request: Request):
    """前端用来校验 key、显示排队状态，不会请求 NAI。"""
    user = _authenticate(request)
    if user is None:
        return _error(401, "Invalid proxy key")
    identity = control.identity(bearer(request)) or {}
    # id 不随改名、换 key 变化，网页端用它区分各人的本地历史
    return {"user": user, "id": identity.get('id'), "is_admin": bool(identity.get('owner')),
            "queue": {"busy": queue._lock.locked(), "waiting": queue.waiting}}


# 自带的网页前端；必须注册在下面的通配路由之前。
# 页面里的脚本和样式走 /static/v/<版本>/…，版本是网页文件内容的哈希：
# 更新后地址就变了，浏览器和 Cloudflare 不会继续用旧缓存（JS 里的相对 import 也跟着变）。
def _asset_version() -> str:
    digest = hashlib.sha256()
    for p in sorted(WEB_DIR.rglob("*")):
        if p.is_file():
            digest.update(p.relative_to(WEB_DIR).as_posix().encode() + b"\0" + p.read_bytes())
    return digest.hexdigest()[:12]


ASSET_VERSION = _asset_version()


def _page(name: str, headers: dict) -> HTMLResponse:
    html = (WEB_DIR / name).read_text(encoding="utf-8").replace("__V__", ASSET_VERSION)
    return HTMLResponse(html, headers=headers)


UI_COOKIE = "nai_ui"


@app.get("/", include_in_schema=False)
async def index(request: Request):
    # 新版（分页面）是默认；Cookie nai_ui=classic 时给旧版单页界面，两边页面里都有切换按钮
    name = "index.html" if request.cookies.get(UI_COOKIE) == "classic" else "studio.html"
    return _page(name, {"Cache-Control": "no-cache", "Vary": "Cookie"})


@app.get("/static/v/{ver}/{name:path}", include_in_schema=False)
async def versioned_static(ver: str, name: str):
    path = (WEB_DIR / name).resolve()
    if not path.is_relative_to(WEB_DIR) or not path.is_file():
        return _error(404, "Not found")
    cache = "public, max-age=31536000, immutable" if ver == ASSET_VERSION else "no-cache"
    return FileResponse(path, headers={"Cache-Control": cache})


class _RevalidatedStatic(StaticFiles):
    """不带版本号的旧地址每次都向服务器确认，避免被缓存几个小时"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", _RevalidatedStatic(directory=WEB_DIR), name="static")


@app.get('/manage', include_in_schema=False)
async def manage_page():
    return _page('manage.html', {'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})


@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy(request: Request, full_path: str):
    t0 = time.monotonic()
    method = request.method
    path = "/" + full_path
    ip = _client_ip(request)

    identity = control.identity(bearer(request))
    user = identity['name'] if identity else None
    if user is None:
        log.event(evt="auth_fail", ip=ip, method=method, path=path)
        return _error(401, "Invalid proxy key")

    upstream = ROUTES.get((method, path))
    if upstream is None:
        log.event(evt="blocked", user=user, ip=ip, method=method, path=path)
        return _error(403, f"{method} {path} is not allowed through this proxy")

    if int(request.headers.get("content-length") or 0) > MAX_BODY:
        return _error(413, "Request body too large")
    body = await request.body()
    if len(body) > MAX_BODY:
        return _error(413, "Request body too large")

    content_type = request.headers.get("content-type", "")
    base = dict(user=user, ip=ip, method=method, path=path, **_summarize(body, content_type))

    # 不转发客户端的任何原始请求头（IP、UA、Cookie 等），全部重新构造
    headers = {
        "User-Agent": config.USER_AGENT,
        "Accept": request.headers.get("accept", "*/*"),
    }
    if content_type:
        headers["Content-Type"] = content_type
    if config.ORIGIN:
        headers["Origin"] = config.ORIGIN
        headers["Referer"] = config.ORIGIN + "/"

    wait = 0.0
    held = False
    # 只有生成类（POST /ai/*）排队；标签补全这类 GET 请求直接放行
    if method == "POST" and path.startswith("/ai/"):
        ahead = queue.waiting + (1 if queue._lock.locked() else 0)
        try:
            wait = await queue.acquire()
        except asyncio.TimeoutError:
            log.event(evt="queue_timeout", ahead=ahead, **base)
            return _error(503, "Proxy queue timeout, another generation is still running")
        held = True
        base["ahead"] = ahead

    def release() -> None:
        nonlocal held
        if held:
            held = False
            queue.release()

    current = control.identity(bearer(request))
    if current is None or current['id'] != identity['id']:
        release()
        return _error(401, 'Invalid proxy key')
    headers['Authorization'] = 'Bearer ' + control.upstream_token

    url = upstream + path + (f"?{request.url.query}" if request.url.query else "")
    try:
        req = client.build_request(method, url, content=body or None, headers=headers)
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        release()
        log.event(evt="upstream_error", wait=round(wait, 2), dur=round(time.monotonic() - t0, 2), error=repr(e), **base)
        return _error(502, f"Upstream error: {type(e).__name__}")
    except BaseException:
        release()
        raise

    out_headers = {k: v for k, v in resp.headers.items() if k.lower() in PASS_RESPONSE_HEADERS}

    # 出错的响应一般很小，读完记下来，方便排查（比如 429 并发锁、402 余额不足）
    if resp.status_code >= 400:
        try:
            content = await resp.aread()
        finally:
            await resp.aclose()
            release()
        log.event(
            evt="request", status=resp.status_code, wait=round(wait, 2),
            dur=round(time.monotonic() - t0, 2), error=content[:300].decode("utf-8", "replace"), **base,
        )
        return Response(content, status_code=resp.status_code, headers=out_headers)

    async def body_iter():
        sent = 0
        done = False
        error = None
        try:
            async for chunk in resp.aiter_bytes():
                sent += len(chunk)
                yield chunk
            done = True
        except httpx.HTTPError as e:
            error = repr(e)
            raise
        finally:
            await resp.aclose()
            release()
            extra = {}
            if error:
                extra["error"] = error
            elif not done:
                extra["aborted"] = True  # 客户端中途断开
            log.event(
                evt="request", status=resp.status_code, wait=round(wait, 2),
                dur=round(time.monotonic() - t0, 2), bytes=sent, **extra, **base,
            )

    return ClosingStreamingResponse(body_iter(), status_code=resp.status_code, headers=out_headers)
