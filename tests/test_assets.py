import base64
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

os.environ.update(NAI_TOKEN='pst-synthetic-' + 'x' * 24, PROXY_KEYS='me:owner10425,friend:member-test-key-12345', DOMAIN='nai.test')
os.environ.setdefault('LOG_DIR', tempfile.mkdtemp())
os.environ.setdefault('TAG_DICT_URL', '')
os.environ.setdefault('TAG_DICT_FILE', str(Path(tempfile.mkdtemp()) / 'tags.sqlite'))
import httpx
from app import main as m

OWNER, MEMBER = 'owner10425', 'member-test-key-12345'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 200
WEBP = b'RIFF\x00\x00\x00\x00WEBPVP8 ' + b'\x00' * 40
ENC = b'\x01\x02vibe-encoding' * 10
MODEL = 'nai-diffusion-4-5-full'


def frame(meta, thumb=WEBP, image=PNG):
    mb = json.dumps(meta).encode()
    return struct.pack('>I', len(mb)) + mb + struct.pack('>I', len(thumb)) + thumb + image


class AssetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        m.control.path = Path(d.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = 'pst-synthetic-' + 'x' * 24, {OWNER: 'me', MEMBER: 'friend'}
        m.control.load()
        self.old = (m.assets.root, m.assets.quota)
        m.assets.root = Path(d.name) / 'users'
        m.assets.quota = 10 << 20
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')

    async def asyncTearDown(self):
        await self.client.aclose()
        m.assets.root, m.assets.quota = self.old

    def h(self, key):
        return {'Authorization': 'Bearer ' + key}

    async def upload(self, key, meta, **kw):
        return await self.client.post('/proxy/assets/items', content=frame(meta, **kw), headers=self.h(key))

    async def test_requires_key(self):
        self.assertEqual((await self.client.get('/proxy/assets')).status_code, 401)
        self.assertEqual((await self.client.post('/proxy/assets/items', content=frame({'kind': 'vibe'}))).status_code, 401)

    async def test_vibe_roundtrip_and_encoding_cache(self):
        r = await self.upload(MEMBER, {'kind': 'vibe', 'name': '水彩', 'category': '画风', 'width': 1024, 'height': 1536,
                                       'params': {'strength': 0.45, 'info': 0.7, 'junk': 1}})
        self.assertEqual(r.status_code, 200, r.text)
        it = r.json()['item']
        self.assertEqual((it['name'], it['category'], it['params']), ('水彩', '画风', {'strength': 0.45, 'info': 0.7}))
        h = self.h(MEMBER)
        img = await self.client.get(f'/proxy/assets/items/{it["id"]}/image', headers=h)
        self.assertEqual((img.status_code, img.content, img.headers['vary']), (200, PNG, 'Authorization'))
        url = f'/proxy/assets/items/{it["id"]}/encoding?model={MODEL}&info=0.7'
        self.assertEqual((await self.client.get(url, headers=h)).status_code, 404)
        r = await self.client.put(url, content=ENC, headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['item']['encodings'], [{'model': MODEL, 'info': 0.7, 'size': len(ENC)}])
        self.assertEqual(len((await self.client.put(url, content=ENC, headers=h)).json()['item']['encodings']), 1)
        got = await self.client.get(url, headers=h)
        self.assertEqual((got.status_code, got.content), (200, ENC))
        self.assertEqual((await self.client.get(url.replace('0.7', '0.5'), headers=h)).status_code, 404)
        self.assertEqual((await self.client.put(url.replace(MODEL, 'evil'), content=ENC, headers=h)).status_code, 400)
        lst = (await self.client.get('/proxy/assets', headers=h)).json()
        self.assertEqual(lst['used'], len(PNG) + len(WEBP) + len(ENC))
        # 别人看不到，也拿不到、写不了编码
        self.assertEqual((await self.client.get('/proxy/assets', headers=self.h(OWNER))).json()['items'], [])
        self.assertEqual((await self.client.get(url, headers=self.h(OWNER))).status_code, 404)
        self.assertEqual((await self.client.put(url, content=ENC, headers=self.h(OWNER))).status_code, 404)

    async def test_import_encoding_only_vibe(self):
        meta = {'kind': 'vibe', 'name': '官网导出', 'encodings': [{'model': MODEL, 'info': 1, 'data': base64.b64encode(ENC).decode()}]}
        r = await self.upload(MEMBER, meta, thumb=b'', image=b'')
        self.assertEqual(r.status_code, 200, r.text)
        it = r.json()['item']
        self.assertEqual((it['size'], it['tsize'], len(it['encodings'])), (0, 0, 1))
        h = self.h(MEMBER)
        self.assertEqual((await self.client.get(f'/proxy/assets/items/{it["id"]}/image', headers=h)).status_code, 404)
        got = await self.client.get(f'/proxy/assets/items/{it["id"]}/encoding?model={MODEL}&info=1.0', headers=h)
        self.assertEqual(got.content, ENC)
        self.assertTrue((await self.upload(MEMBER, meta, thumb=b'', image=b'')).json()['existed'])
        bad = {'kind': 'vibe', 'encodings': [{'model': MODEL, 'info': 1, 'data': '!!notb64'}]}
        self.assertEqual((await self.upload(MEMBER, bad, thumb=b'', image=b'')).status_code, 400)
        self.assertEqual((await self.upload(MEMBER, {'kind': 'ref'}, thumb=b'', image=b'')).status_code, 400)

    async def test_ref_and_dedupe_per_kind(self):
        a = (await self.upload(MEMBER, {'kind': 'ref', 'params': {'type': 'style', 'strength': 2}})).json()
        self.assertEqual(a['item']['params'], {'type': 'style', 'strength': 1.0, 'fidelity': 0.8})
        self.assertTrue((await self.upload(MEMBER, {'kind': 'ref'})).json()['existed'])
        self.assertFalse((await self.upload(MEMBER, {'kind': 'vibe'})).json()['existed'])
        self.assertEqual((await self.upload(MEMBER, {'kind': 'nope'})).status_code, 400)
        url = f'/proxy/assets/items/{a["item"]["id"]}/encoding?model={MODEL}&info=1'
        self.assertEqual((await self.client.put(url, content=ENC, headers=self.h(MEMBER))).status_code, 404)

    async def test_update_move_delete(self):
        h = self.h(MEMBER)
        it = (await self.upload(MEMBER, {'kind': 'vibe'})).json()['item']
        await self.client.put(f'/proxy/assets/items/{it["id"]}/encoding?model={MODEL}&info=1', content=ENC, headers=h)
        r = await self.client.patch(f'/proxy/assets/items/{it["id"]}', json={'name': '夜景', 'params': {'strength': 0.9}}, headers=h)
        self.assertEqual((r.json()['item']['name'], r.json()['item']['params']), ('夜景', {'strength': 0.9, 'info': 1.0}))
        self.assertEqual((await self.client.patch('/proxy/assets/items/0123456789abcdef', json={}, headers=h)).status_code, 404)
        r = await self.client.post('/proxy/assets/batch', json={'op': 'move', 'ids': [it['id']], 'category': '场景'}, headers=h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.client.get('/proxy/assets', headers=h)).json()['items'][0]['category'], '场景')
        r = await self.client.post('/proxy/assets/batch', json={'op': 'delete', 'ids': [it['id']]}, headers=h)
        self.assertEqual(r.json()['used'], 0)
        files = [p for p in m.assets.root.rglob('*') if p.is_file() and p.name != 'index.json']
        self.assertEqual(files, [])
        for body in [{'op': 'x', 'ids': []}, {'op': 'delete', 'ids': 'a'}]:
            self.assertEqual((await self.client.post('/proxy/assets/batch', json=body, headers=h)).status_code, 400)

    async def test_quota(self):
        m.assets.quota = len(PNG) + len(WEBP) + 10
        it = (await self.upload(MEMBER, {'kind': 'vibe'})).json()['item']
        r = await self.client.put(f'/proxy/assets/items/{it["id"]}/encoding?model={MODEL}&info=1', content=ENC, headers=self.h(MEMBER))
        self.assertEqual(r.status_code, 507)
        self.assertIn('空间不够', r.json()['message'])
