import os
from pathlib import Path
import tempfile
import unittest

os.environ.update(NAI_TOKEN='pst-synthetic-' + 'x' * 24, PROXY_KEYS='me:owner10425,friend:member-test-key-12345', DOMAIN='nai.test')
os.environ.setdefault('LOG_DIR', tempfile.mkdtemp())
os.environ.setdefault('TAG_DICT_URL', '')
os.environ.setdefault('TAG_DICT_FILE', str(Path(tempfile.mkdtemp()) / 'tags.sqlite'))
import httpx
from app import main as m
from app.userdata import UserData

OWNER, MEMBER = 'owner10425', 'member-test-key-12345'


class UserDataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        m.control.path = Path(d.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = 'pst-synthetic-' + 'x' * 24, {OWNER: 'me', MEMBER: 'friend'}
        m.control.load()
        self.old = m.user_data.root
        m.user_data.root = Path(d.name) / 'users'
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')

    async def asyncTearDown(self):
        await self.client.aclose()
        m.user_data.root = self.old

    def h(self, key):
        return {'Authorization': 'Bearer ' + key}

    async def test_requires_key_and_known_kind(self):
        self.assertEqual((await self.client.get('/proxy/userdata/library')).status_code, 401)
        self.assertEqual((await self.client.put('/proxy/userdata/library', json={'rev': 0, 'data': {}}, headers=self.h('nope-nope-nope'))).status_code, 401)
        self.assertEqual((await self.client.get('/proxy/userdata/secrets', headers=self.h(MEMBER))).status_code, 404)
        self.assertIn((await self.client.get('/proxy/userdata/..%2Fcontrol', headers=self.h(MEMBER))).status_code, (403, 404))

    async def test_roundtrip_conflict_and_isolation(self):
        r = (await self.client.get('/proxy/userdata/snapshots', headers=self.h(MEMBER))).json()
        self.assertEqual((r['rev'], r['data']), (0, None))
        r = await self.client.put('/proxy/userdata/snapshots', json={'rev': 0, 'data': {'items': [1]}}, headers=self.h(MEMBER))
        self.assertEqual(r.json()['rev'], 1)
        # 拿旧 rev 再存：冲突，返回最新内容
        r = await self.client.put('/proxy/userdata/snapshots', json={'rev': 0, 'data': {'items': [2]}}, headers=self.h(MEMBER))
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()['current']['data'], {'items': [1]})
        r = (await self.client.get('/proxy/userdata/snapshots', headers=self.h(MEMBER))).json()
        self.assertEqual((r['rev'], r['data']), (1, {'items': [1]}))
        # 别人看不到
        r = (await self.client.get('/proxy/userdata/snapshots', headers=self.h(OWNER))).json()
        self.assertIsNone(r['data'])

    async def test_validation_and_size_limit(self):
        for body in [b'nope', b'{"rev":"0","data":{}}', b'{"rev":0,"data":[]}', b'{"data":{}}']:
            r = await self.client.put('/proxy/userdata/library', content=body, headers=self.h(MEMBER))
            self.assertEqual(r.status_code, 400, body)
        r = await self.client.put('/proxy/userdata/library', json={'rev': 0, 'data': {'x': 'a' * (3 << 20)}}, headers=self.h(MEMBER))
        self.assertEqual(r.status_code, 413)

    def test_rejects_bad_user_id(self):
        u = UserData(Path(tempfile.mkdtemp()))
        with self.assertRaises(ValueError):
            u.read('../x', 'library')


if __name__ == '__main__':
    unittest.main()
