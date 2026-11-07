import json
import logging
import os
import sys
from logging.handlers import TimedRotatingFileHandler

from . import config

_logger = logging.getLogger("nai-proxy")


def setup() -> None:
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    fmt = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    _logger.addHandler(stream)

    os.makedirs(config.LOG_DIR, exist_ok=True)
    file = TimedRotatingFileHandler(
        os.path.join(config.LOG_DIR, "proxy.log"),
        when="midnight",
        backupCount=config.LOG_RETENTION_DAYS,
        encoding="utf-8",
    )
    file.setFormatter(fmt)
    _logger.addHandler(file)


def event(**fields) -> None:
    """一行一条 JSON，方便 grep / jq"""
    _logger.info(json.dumps(fields, ensure_ascii=False, separators=(",", ":")))
