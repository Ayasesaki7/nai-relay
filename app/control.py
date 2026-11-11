"""Private runtime credentials, persisted atomically for the single-worker service."""
import copy
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def masked(value):
    return value[:4] + '…' + value[-4:]


class ControlStore:
    def __init__(self, path, token, keys):
        self.path = Path(path)
        self.seed_token, self.seed_keys = token, keys
        self._lock = threading.RLock()
        self._data = None

    def load(self):
        with self._lock:
            if self.path.exists():
                data = json.loads(self.path.read_text(encoding='utf-8'))
                rows = data['keys']
                if (data.get('version') != 1 or not data.get('upstream_token') or
                    not any(r['owner'] and r['enabled'] for r in rows) or
                    len({r['key'] for r in rows}) != len(rows)):
                    raise RuntimeError('管理配置无效，请从备份恢复；不会重置现有 Key')
                self.path.chmod(0o600)
                self._data = data
                return
            owner = next((key for key, name in self.seed_keys.items() if name == 'me'), next(iter(self.seed_keys)))
            rows = [dict(id=secrets.token_hex(12), name=name, key=key, enabled=True,
                         owner=key == owner, created_at=now()) for key, name in self.seed_keys.items()]
            self._commit(dict(version=1, revision=1, upstream_token=self.seed_token, subscription=None, keys=rows))

    def _commit(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, name = tempfile.mkstemp(dir=self.path.parent, prefix='.control-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                os.chmod(name, 0o600)
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
            self._data = data
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def identity(self, token):
        with self._lock:
            found = None
            for row in self._data['keys']:
                if hmac.compare_digest(row['key'].encode(), token.encode()) and row['enabled']:
                    found = {k: row[k] for k in ['id', 'name', 'owner']}
            return found

    @property
    def upstream_token(self):
        with self._lock:
            return self._data['upstream_token']

    def summary(self):
        with self._lock:
            return dict(revision=self._data['revision'], upstream=masked(self._data['upstream_token']),
                        subscription=copy.deepcopy(self._data['subscription']), keys=[
                            {**{k: r[k] for k in ['id', 'name', 'enabled', 'owner', 'created_at']}, 'masked': masked(r['key'])}
                            for r in self._data['keys']])

    def upstream(self, token, subscription):
        with self._lock:
            data = copy.deepcopy(self._data)
            data.update(upstream_token=token, subscription={**subscription, 'checked_at': now()})
            data['revision'] += 1
            self._commit(data)

    def key(self, key_id):
        with self._lock:
            return next(r['key'] for r in self._data['keys'] if r['id'] == key_id)

    def change(self, action, values, key_id=None):
        with self._lock:
            data = copy.deepcopy(self._data)
            rows = data['keys']
            row = next((r for r in rows if r['id'] == key_id), None)
            if action != 'create' and row is None:
                raise ValueError('Key 不存在')
            if row and row['owner'] and (action in ['delete', 'rotate'] or values.get('enabled') is False):
                raise ValueError('不能停用、删除或轮换管理 Key，避免失去管理入口')
            if action == 'create':
                if len(rows) >= 200:
                    raise ValueError('最多支持 200 个 Key')
                row = dict(id=secrets.token_hex(12), name='', key='', enabled=True, owner=False, created_at=now())
                rows.append(row)
            if action in ['create', 'edit'] and ('name' in values or action == 'create'):
                if not isinstance(values.get('name'), str):
                    raise ValueError('名称必须是文字')
                name = values['name'].strip()
                if not 1 <= len(name) <= 40 or any(ord(c) < 32 for c in name):
                    raise ValueError('名称需为 1–40 个字符')
                if any(r['id'] != row['id'] and r['name'].casefold() == name.casefold() for r in rows):
                    raise ValueError('名称已存在')
                row['name'] = name
            if action in ['create', 'rotate']:
                key = values.get('key') or 'sk-' + secrets.token_urlsafe(32)
                if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,128}', key):
                    raise ValueError('自定义 Key 需为 10–128 位字母、数字、下划线或短横线')
                if any(r['key'] == key and r['id'] != row['id'] for r in rows):
                    raise ValueError('Key 已存在')
                row['key'] = key
            if 'enabled' in values:
                if type(values['enabled']) is not bool:
                    raise ValueError('enabled 必须是布尔值')
                row['enabled'] = values['enabled']
            if action == 'delete':
                rows.remove(row)
            data['revision'] += 1
            self._commit(data)
            return dict(id=row['id'], name=row['name'], **({'key': row['key']} if action in ['create', 'rotate'] else {}))
