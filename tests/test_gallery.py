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
from app.gallery import Gallery

OWNER, MEMBER = 'owner10425', 'member-test-key-12345'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 200
WEBP = b'RIFF\x00\x00\x00\x00WEBPVP8 ' + b'\x00' * 40


def frame(meta, thumb=WEBP, image=PNG):
    mb = json.dumps(meta).encode()
    return struct.pack('>I', len(mb)) + mb + struct.pack('>I', len(thumb)) + thumb + image


class GalleryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        m.control.path = Path(d.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = 'pst-synthetic-' + 'x' * 24, {OWNER: 'me', MEMBER: 'friend'}
        m.control.load()
        self.old = (m.gallery.root, m.gallery.quota)
        m.gallery.root = Path(d.name) / 'users'
        m.gallery.quota = 10 << 20
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')

    async def asyncTearDown(self):
        await self.client.aclose()
        m.gallery.root, m.gallery.quota = self.old

    def h(self, key):
        return {'Authorization': 'Bearer ' + key}

    async def upload(self, key, meta=None, **kw):
        return await self.client.post('/proxy/gallery/items', content=frame(meta or {}, **kw), headers=self.h(key))

    async def test_requires_key(self):
        self.assertEqual((await self.client.get('/proxy/gallery')).status_code, 401)
        self.assertEqual((await self.client.post('/proxy/gallery/items', content=frame({}))).status_code, 401)
        self.assertEqual((await self.client.get('/proxy/gallery/items/0123456789abcdef/image')).status_code, 401)

    async def test_upload_list_fetch(self):
        r = await self.upload(MEMBER, {'width': 832, 'height': 1216, 'tool': '放大 4×', 'params': {'prompt': '1girl', 'seed': '5'}, 'created': 123})
        self.assertEqual(r.status_code, 200, r.text)
        item = r.json()['item']
        self.assertEqual((item['width'], item['height'], item['tool'], item['type'], item['created']), (832, 1216, '放大 4×', 'image/png', 123))
        self.assertFalse(r.json()['existed'])
        lst = (await self.client.get('/proxy/gallery', headers=self.h(MEMBER))).json()
        self.assertEqual([x['id'] for x in lst['items']], [item['id']])
        self.assertEqual(lst['items'][0]['params']['prompt'], '1girl')
        self.assertEqual(lst['used'], len(PNG) + len(WEBP))
        img = await self.client.get(f'/proxy/gallery/items/{item["id"]}/image', headers=self.h(MEMBER))
        self.assertEqual((img.status_code, img.content, img.headers['content-type']), (200, PNG, 'image/png'))
        self.assertIn('private', img.headers['cache-control'])
        self.assertEqual(img.headers['vary'], 'Authorization')
        th = await self.client.get(f'/proxy/gallery/items/{item["id"]}/thumb', headers=self.h(MEMBER))
        self.assertEqual((th.content, th.headers['content-type']), (WEBP, 'image/webp'))

    async def test_same_image_saved_once(self):
        a = (await self.upload(MEMBER)).json()
        b = (await self.upload(MEMBER)).json()
        self.assertTrue(b['existed'])
        self.assertEqual(a['item']['id'], b['item']['id'])
        self.assertEqual(b['count'], 1)

    async def test_users_are_isolated(self):
        item = (await self.upload(MEMBER)).json()['item']
        self.assertEqual((await self.client.get('/proxy/gallery', headers=self.h(OWNER))).json()['items'], [])
        self.assertEqual((await self.client.get(f'/proxy/gallery/items/{item["id"]}/image', headers=self.h(OWNER))).status_code, 404)
        r = await self.client.post('/proxy/gallery/batch', json={'op': 'delete', 'ids': [item['id']]}, headers=self.h(OWNER))
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.client.get(f'/proxy/gallery/items/{item["id"]}/image', headers=self.h(MEMBER))).status_code, 200)

    async def test_rejects_bad_uploads(self):
        bad = [b'', b'\x00\x00\x00\x05{}', frame({}, image=b'not an image'), frame({}, thumb=b'nope'), frame([1, 2])]
        for body in bad:
            r = await self.client.post('/proxy/gallery/items', content=body, headers=self.h(MEMBER))
            self.assertEqual(r.status_code, 400, body[:20])
        for p in ['../x', '0123', 'ZZZZZZZZZZZZZZZZ']:
            r = await self.client.get(f'/proxy/gallery/items/{p}/image', headers=self.h(MEMBER))
            self.assertIn(r.status_code, (403, 404))

    async def test_quota(self):
        m.gallery.quota = len(PNG) + len(WEBP) + 10
        self.assertEqual((await self.upload(MEMBER)).status_code, 200)
        r = await self.upload(MEMBER, image=PNG + b'\x01')
        self.assertEqual(r.status_code, 507)
        self.assertIn('空间不够', r.json()['message'])

    async def test_albums_move_and_delete(self):
        h = self.h(MEMBER)
        a = (await self.client.post('/proxy/gallery/albums', json={'name': '初音'}, headers=h)).json()['album']
        self.assertEqual((await self.client.post('/proxy/gallery/albums', json={'name': '初音'}, headers=h)).status_code, 409)
        self.assertEqual((await self.client.post('/proxy/gallery/albums', json={'name': '  '}, headers=h)).status_code, 400)
        i1 = (await self.upload(MEMBER, {'album': a['id']})).json()['item']
        i2 = (await self.upload(MEMBER, {'album': 'missing'}, image=PNG + b'2')).json()['item']
        self.assertEqual((i1['album'], i2['album']), (a['id'], ''))
        r = await self.client.post('/proxy/gallery/batch', json={'op': 'move', 'ids': [i2['id']], 'album': a['id']}, headers=h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.client.post('/proxy/gallery/batch', json={'op': 'move', 'ids': [i2['id']], 'album': 'nope'}, headers=h)).status_code, 404)
        r = await self.client.patch(f'/proxy/gallery/albums/{a["id"]}', json={'name': '初音未来'}, headers=h)
        self.assertEqual(r.json()['albums'][0]['name'], '初音未来')
        self.assertEqual((await self.client.delete(f'/proxy/gallery/albums/{a["id"]}', headers=h)).status_code, 200)
        lst = (await self.client.get('/proxy/gallery', headers=h)).json()
        self.assertEqual((lst['albums'], [x['album'] for x in lst['items']]), ([], ['', '']))
        r = await self.client.post('/proxy/gallery/batch', json={'op': 'delete', 'ids': [i1['id'], i2['id']]}, headers=h)
        self.assertEqual(r.json()['used'], 0)
        self.assertEqual((await self.client.get(f'/proxy/gallery/items/{i1["id"]}/image', headers=h)).status_code, 404)
        files = [p for p in (m.gallery.root).rglob('*') if p.is_file() and p.name != 'index.json']
        self.assertEqual(files, [])

    async def test_bad_batch(self):
        h = self.h(MEMBER)
        for body in [{'op': 'explode', 'ids': []}, {'op': 'delete', 'ids': 'x'}, [1]]:
            self.assertEqual((await self.client.post('/proxy/gallery/batch', json=body, headers=h)).status_code, 400)

    def test_rejects_bad_user_id(self):
        with self.assertRaises(ValueError):
            Gallery('/tmp/x', 1).listing('../etc')
