import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

OWNER, MEMBER = 'owner10425', 'member-test-key-12345'
os.environ.update(NAI_TOKEN='pst-synthetic-' + 'x' * 24, PROXY_KEYS=f'me:{OWNER},friend:{MEMBER}', DOMAIN='nai.test')
os.environ.setdefault('LOG_DIR', tempfile.mkdtemp())
import httpx
from app.control import ControlStore
from app import main as m

TOKEN = 'pst-synthetic-' + 'x' * 24


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'control.json'
        self.store = ControlStore(self.path, TOKEN, {OWNER: 'me', MEMBER: 'friend'})
        self.store.load()

    def test_persistent_authority_and_secret_masking(self):
        result = self.store.change('create', {'name': '新用户'})
        other = ControlStore(self.path, 'pst-stale', {'stale-seed': 'me'})
        other.load()
        self.assertEqual(other.identity(result['key'])['name'], '新用户')
        self.assertIsNone(other.identity('stale-seed'))
        text = json.dumps(other.summary())
        for secret in [TOKEN, OWNER, MEMBER, result['key']]:
            self.assertNotIn(secret, text)
        if os.name != 'nt':
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_key_lifecycle_and_owner_protection(self):
        result = self.store.change('create', {'name': 'custom', 'key': 'reader1025'})
        self.assertIsNotNone(self.store.identity('reader1025'))
        self.store.change('edit', {'enabled': False}, result['id'])
        self.assertIsNone(self.store.identity('reader1025'))
        self.store.change('edit', {'enabled': True, 'name': 'renamed'}, result['id'])
        replacement = self.store.change('rotate', {}, result['id'])
        self.assertIsNone(self.store.identity('reader1025'))
        self.assertIsNotNone(self.store.identity(replacement['key']))
        self.store.change('delete', {}, result['id'])
        self.assertIsNone(self.store.identity(replacement['key']))
        owner = self.store.identity(OWNER)['id']
        for action, body in [('delete', {}), ('rotate', {}), ('edit', {'enabled': False})]:
            with self.assertRaises(ValueError):
                self.store.change(action, body, owner)

    def test_validation_and_failed_write_preserve_state(self):
        before = self.path.read_bytes()
        for body in [{'name': 'me'}, {'name': 'short', 'key': 'short'}, {'name': 'copy', 'key': MEMBER}]:
            with self.assertRaises(ValueError):
                self.store.change('create', body)
        with patch('app.control.os.replace', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                self.store.change('create', {'name': 'unsaved'})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(self.store.summary()['keys']), 2)

    def test_corrupt_state_fails_closed(self):
        self.path.write_text('{broken')
        with self.assertRaises(ValueError):
            self.store.load()
        self.assertEqual(self.path.read_text(), '{broken')


class ManagementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        m.control.path = Path(self.directory.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = TOKEN, {OWNER: 'me', MEMBER: 'friend'}
        self.life = m.lifespan(m.app)
        await self.life.__aenter__()
        await m.client.aclose()
        self.calls = []

        async def upstream(request):
            self.calls.append(request)
            if request.method == 'GET':
                if 'invalid' in request.headers['authorization']:
                    return httpx.Response(401, json={'message': 'bad token'})
                return httpx.Response(200, json={'tier': 3, 'active': True, 'trainingStepsLeft': {'fixedTrainingStepsLeft': 10000}})
            return httpx.Response(200, content=b'synthetic-image')
        m.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.life.__aexit__(None, None, None)

    async def request(self, method, path='', body=None, key=OWNER, origin='https://nai.test', extra=None):
        headers = {'Authorization': 'Bearer ' + key}
        if origin is not None:
            headers['Origin'] = origin
        headers.update(extra or {})
        return await self.client.request(method, '/proxy/manage' + path, json=body, headers=headers)

    async def test_authorization_origin_and_public_surface(self):
        self.assertEqual((await self.request('GET', key='bad')).status_code, 401)
        self.assertEqual((await self.request('GET', key=MEMBER)).status_code, 403)
        self.assertEqual((await self.request('GET', origin='https://evil.test')).status_code, 403)
        self.assertEqual((await self.request('GET', extra={'Sec-Fetch-Site': 'cross-site'})).status_code, 403)
        for origin in [None, 'https://evil.test']:
            self.assertEqual((await self.request('POST', '/keys', {'name': 'blocked'}, origin=origin)).status_code, 403)
        self.assertEqual(len(m.control.summary()['keys']), 2)
        page = await self.client.get('/manage')
        self.assertEqual(page.status_code, 200)
        self.assertIn('frame-ancestors', page.headers['content-security-policy'])
        me = await self.client.get('/proxy/me', headers={'Authorization': 'Bearer ' + OWNER})
        self.assertTrue(me.json()['is_admin'])

    async def test_api_lifecycle_and_secret_access(self):
        created = await self.request('POST', '/keys', {'name': '<b>朋友</b>', 'key': 'reader1025'})
        self.assertEqual(created.status_code, 200)
        row = created.json()
        self.assertEqual((await self.request('GET', f"/keys/{row['id']}/secret", key=MEMBER)).status_code, 403)
        self.assertEqual((await self.request('GET', f"/keys/{row['id']}/secret")).json()['key'], 'reader1025')
        text = (await self.request('GET')).text
        self.assertNotIn(TOKEN, text)
        self.assertNotIn(OWNER, text)
        self.assertNotIn('reader1025', text)
        await self.request('PATCH', '/keys/' + row['id'], {'enabled': False})
        me = await self.client.get('/proxy/me', headers={'Authorization': 'Bearer reader1025'})
        self.assertEqual(me.status_code, 401)
        await self.request('PATCH', '/keys/' + row['id'], {'enabled': True})
        rotated = (await self.request('POST', '/keys/' + row['id'] + '/rotate', {})).json()
        self.assertIsNone(m.control.identity('reader1025'))
        self.assertIsNotNone(m.control.identity(rotated['key']))
        self.assertEqual((await self.request('DELETE', '/keys/' + row['id'], {})).status_code, 200)
        self.assertEqual((await self.request('GET', '/keys/unknown/secret')).status_code, 404)

    async def test_pst_verification_and_persistence(self):
        failed = await self.request('POST', '/upstream', {'token': 'pst-invalid-' + 'x' * 24})
        self.assertEqual(failed.status_code, 400)
        self.assertEqual(m.control.upstream_token, TOKEN)
        token = 'pst-replacement-' + 'z' * 24
        ok = await self.request('POST', '/upstream', {'token': token})
        self.assertEqual(ok.status_code, 200)
        self.assertNotIn(token, ok.text)
        self.assertEqual(m.control.upstream_token, token)
        m.control.load()
        self.assertEqual(m.control.upstream_token, token)
        self.assertTrue(all(r.method == 'GET' and r.url.path == '/user/subscription' for r in self.calls))
        request = self.calls[-1]
        self.assertEqual(request.headers['user-agent'], m.config.USER_AGENT)
        self.assertNotIn('cookie', request.headers)

    async def test_queued_revocation_and_latest_upstream(self):
        m.config.MIN_INTERVAL, m.config.JITTER = 0, 0
        await m.queue.acquire()
        async def generate():
            return await self.client.post('/ai/generate-image', json={}, headers={'Authorization': 'Bearer ' + MEMBER})
        task = asyncio.create_task(generate())
        while not m.queue.waiting:
            await asyncio.sleep(0.001)
        row = m.control.identity(MEMBER)
        m.control.change('edit', {'enabled': False}, row['id'])
        m.queue.release()
        self.assertEqual((await task).status_code, 401)
        self.assertEqual(len(self.calls), 0)
        m.control.change('edit', {'enabled': True}, row['id'])
        await m.queue.acquire()
        task = asyncio.create_task(generate())
        while not m.queue.waiting:
            await asyncio.sleep(0.001)
        token = 'pst-latest-' + 'z' * 24
        m.control.upstream(token, {'tier': 3})
        m.queue.release()
        self.assertEqual((await task).status_code, 200)
        self.assertEqual(self.calls[-1].headers['authorization'], 'Bearer ' + token)
        self.assertFalse(m.queue._lock.locked())

    async def test_me_reports_stable_id(self):
        auth = {'Authorization': 'Bearer ' + MEMBER}
        me = (await self.client.get('/proxy/me', headers=auth)).json()
        self.assertEqual(me['id'], m.control.identity(MEMBER)['id'])
        self.assertFalse(me['is_admin'])
        self.assertEqual((await self.client.get('/proxy/me')).status_code, 401)
    async def test_pages_use_versioned_assets(self):
        v = m.ASSET_VERSION
        for page in ['/', '/manage']:
            html = (await self.client.get(page)).text
            self.assertNotIn('__V__', html)
            self.assertIn(f'/static/v/{v}/style.css', html)
        js = await self.client.get(f'/static/v/{v}/js/util.js')
        self.assertEqual(js.status_code, 200)
        self.assertIn('immutable', js.headers['cache-control'])
        self.assertEqual((await self.client.get('/static/v/old/js/util.js')).headers['cache-control'], 'no-cache')
        self.assertEqual((await self.client.get('/static/js/util.js')).headers['cache-control'], 'no-cache')
        for bad in [f'/static/v/{v}/../app/config.py', f'/static/v/{v}/%2e%2e/app/config.py', f'/static/v/{v}/nope.js']:
            self.assertEqual((await self.client.get(bad)).status_code, 404, bad)


if __name__ == '__main__':
    unittest.main()
