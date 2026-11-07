import os


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"缺少环境变量 {name}，请检查 .env")
    return value


def _parse_keys(raw: str) -> dict[str, str]:
    """PROXY_KEYS=name1:key1,name2:key2 -> {key: name}"""
    keys: dict[str, str] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        name, sep, key = item.partition(":")
        name, key = name.strip(), key.strip()
        if not sep or not name or not key:
            raise RuntimeError(f"PROXY_KEYS 格式错误: {item!r}，应为 name:key")
        if len(key) < 16:
            raise RuntimeError(f"用户 {name} 的 key 太短，至少 16 位")
        keys[key] = name
    if not keys:
        raise RuntimeError("PROXY_KEYS 里至少要配置一个用户")
    return keys


NAI_TOKEN = _require("NAI_TOKEN")
PROXY_KEYS = _parse_keys(_require("PROXY_KEYS"))

IMAGE_UPSTREAM = os.environ.get("IMAGE_UPSTREAM", "https://image.novelai.net").rstrip("/")
API_UPSTREAM = os.environ.get("API_UPSTREAM", "https://api.novelai.net").rstrip("/")

# 发往 NAI 的固定请求头，所有用户共用同一组
USER_AGENT = os.environ.get(
    "USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
)
ORIGIN = os.environ.get("ORIGIN", "https://novelai.net").rstrip("/")

# 生图排队：同一时间只放一个请求出去
QUEUE_TIMEOUT = float(os.environ.get("QUEUE_TIMEOUT", "300"))  # 排队最多等多久（秒）
MIN_INTERVAL = float(os.environ.get("MIN_INTERVAL", "1.0"))  # 两次生成之间最少间隔（秒）
JITTER = float(os.environ.get("JITTER", "1.5"))  # 在最少间隔上再加 0~JITTER 秒随机

UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "300"))
MAX_BODY_MB = float(os.environ.get("MAX_BODY_MB", "50"))

LOG_DIR = os.environ.get("LOG_DIR", "/app/logs")
LOG_RETENTION_DAYS = int(os.environ.get("LOG_RETENTION_DAYS", "30"))
LOG_PROMPT = os.environ.get("LOG_PROMPT", "false").lower() in ("1", "true", "yes")
LOG_PROMPT_MAX = int(os.environ.get("LOG_PROMPT_MAX", "300"))
