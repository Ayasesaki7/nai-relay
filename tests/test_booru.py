import json
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
from app import booru as b

OWNER = 'owner10425'
JPG = b'\xff\xd8\xff\xe0' + b'\x00' * 100


def dpost(i, rating='g', tags='1girl solo', ext='jpg', file=True):
    h = f'{i:032x}'
    return {
        'id': i, 'rating': rating, 'file_ext': ext, 'image_width': 800, 'image_height': 1200, 'score': i, 'fav_count': 2,
        'tag_string': tags, 'tag_string_general': tags, 'tag_string_character': 'hatsune_miku', 'tag_string_copyright': 'vocaloid',
        'tag_string_artist': 'someone', 'tag_string_meta': 'highres', 'source': 'https://example.com/x',
        'file_url': f'https://cdn.donmai.us/original/{h}.{ext}' if file else None,
        'large_file_url': f'https://cdn.donmai.us/sample/sample-{h}.jpg', 'preview_file_url': f'https://cdn.donmai.us/180x180/{h}.jpg',
        'media_asset': {'variants': [{'type': '360x360', 'url': f'https://cdn.donmai.us/360x360/{h}.jpg'}]},
    }


class BooruTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        m.control.path = Path(d.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = 'pst-synthetic-' + 'x' * 24, {OWNER: 'me'}
        m.control.load()
        self.calls = []

        def upstream(req: httpx.Request):
            self.calls.append(req)
            u = req.url
            if u.host == 'cdn.donmai.us':
                if 'big' in u.path:
                    return httpx.Response(200, content=b'x', headers={'content-type': 'image/jpeg', 'content-length': str(b.MAX_IMAGE + 1)})
                if 'html' in u.path:
                    return httpx.Response(200, content=b'<html>', headers={'content-type': 'text/html'})
                return httpx.Response(200, content=JPG, headers={'content-type': 'image/jpeg'})
            if u.path == '/posts.json':
                tags = u.params.get('tags', '').split()
                if 'huge' in tags:
                    return httpx.Response(500, json={'success': False, 'error': 'ActiveRecord::QueryCanceled', 'message': 'The database timed out running your query.'})
                if len([t for t in tags if not t.startswith('rating:')]) + (u.params.get('random') == 'true') > 2:
                    return httpx.Response(422, json={'success': False, 'message': 'You cannot search for more than 2 tags at a time.'})
                return httpx.Response(200, json=[dpost(1), dpost(2, 'e'), dpost(3, tags='1girl loli'), dpost(4, ext='mp4'),
                                                 dpost(5, file=False), dpost(6, 's')])
            if u.path == '/explore/posts/popular.json':
                return httpx.Response(200, json=[dpost(7), dpost(8, 'q')])
            if u.path == '/index.php':
                if u.host == 'gelbooru.com':
                    return httpx.Response(200, json={'@attributes': {}, 'post': [{'id': 9, 'image': 'abc.png', 'directory': 'aa', 'tags': 'a b',
                                                                                  'rating': 'general', 'file_url': 'https://img3.gelbooru.com/images/abc.png'}]})
                if 'none' in u.params.get('tags', ''):
                    return httpx.Response(200, content=b'')
                return httpx.Response(200, json=[{'id': 10, 'image': 'f00.jpg', 'directory': 12, 'tags': 'smile 1girl', 'rating': 'safe',
                                                  'width': 10, 'height': 20, 'sample': False}])
            return httpx.Response(404)

        self.old_client = getattr(m, 'client', None)
        m.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')
        self.h = {'Authorization': 'Bearer ' + OWNER}
        self.env = {k: os.environ.pop(k, None) for k in ('GELBOORU_API_KEY', 'GELBOORU_USER_ID')}

    async def asyncTearDown(self):
        await self.client.aclose()
        await m.client.aclose()
        m.client = self.old_client
        for k, v in self.env.items():
            if v is not None:
                os.environ[k] = v

    async def get(self, path, **params):
        return await self.client.get(path, params=params, headers=self.h)

    async def test_requires_key(self):
        for p in ('/proxy/booru/sources', '/proxy/booru/posts', '/proxy/booru/image?u=https://cdn.donmai.us/a.jpg'):
            self.assertEqual((await self.client.get(p)).status_code, 401, p)

    async def test_danbooru_filters_and_normalizes(self):
        r = await self.get('/proxy/booru/posts', src='danbooru', tags='1girl', rating='g,s')
        self.assertEqual(r.status_code, 200, r.text)
        items = r.json()['items']
        self.assertEqual([x['id'] for x in items], [1, 6])  # 去掉 e、loli、视频、没有原图的
        x = items[0]
        self.assertEqual(x['tags']['character'], ['hatsune_miku'])
        self.assertTrue(x['preview'].startswith('https://cdn.donmai.us/360x360/'))
        self.assertIn('rating:g,s', self.calls[-1].url.params['tags'])
        await self.get('/proxy/booru/posts', src='danbooru', tags='1girl', rating='g,s,q,e', page=2)
        self.assertNotIn('rating', self.calls[-1].url.params['tags'])
        self.assertEqual(self.calls[-1].url.params['page'], '2')

    async def test_danbooru_modes(self):
        r = await self.get('/proxy/booru/posts', src='danbooru', mode='popular', scale='week', rating='g,s,q,e')
        self.assertEqual([x['id'] for x in r.json()['items']], [7, 8])
        self.assertEqual(self.calls[-1].url.params['scale'], 'week')
        r = await self.get('/proxy/booru/posts', src='danbooru', mode='random', tags='1girl solo')
        self.assertEqual(r.status_code, 400)
        self.assertIn('最多 2 个 TAG', r.json()['message'])
        await self.get('/proxy/booru/posts', src='danbooru', mode='score', tags='1girl')
        self.assertIn('order:score', self.calls[-1].url.params['tags'])
        r = await self.get('/proxy/booru/posts', src='danbooru', mode='score', tags='huge')
        self.assertEqual(r.status_code, 504)
        self.assertIn('查询超时', r.json()['message'])
        self.assertEqual((await self.get('/proxy/booru/posts', src='danbooru', mode='nope')).status_code, 400)
        self.assertEqual((await self.get('/proxy/booru/posts', src='danbooru', rating='x')).status_code, 400)

    async def test_safebooru_and_gelbooru(self):
        r = await self.get('/proxy/booru/posts', src='safebooru', mode='random', tags='smile', page=3)
        x = r.json()['items'][0]
        self.assertEqual((x['src'], x['rating'], x['tags']['general']), ('safebooru', 'g', ['smile', '1girl']))
        self.assertEqual(x['file'], 'https://safebooru.org/images/12/f00.jpg')
        self.assertEqual(x['preview'], 'https://safebooru.org/thumbnails/12/thumbnail_f00.jpg')
        self.assertEqual((self.calls[-1].url.params['pid'], self.calls[-1].url.params['tags']), ('2', 'smile sort:random'))
        r = await self.get('/proxy/booru/posts', src='safebooru', tags='none')
        self.assertEqual(r.json()['items'], [])
        self.assertEqual((await self.get('/proxy/booru/posts', src='safebooru', mode='popular')).status_code, 400)
        r = await self.get('/proxy/booru/posts', src='gelbooru')
        self.assertEqual(r.status_code, 400)
        self.assertIn('GELBOORU_API_KEY', r.json()['message'])
        src = {s['id']: s['ready'] for s in (await self.get('/proxy/booru/sources')).json()['items']}
        self.assertEqual(src, {'danbooru': True, 'safebooru': True, 'gelbooru': False})
        os.environ.update(GELBOORU_API_KEY='k', GELBOORU_USER_ID='1')
        try:
            r = await self.get('/proxy/booru/posts', src='gelbooru')
            self.assertEqual(r.json()['items'][0]['file'], 'https://img3.gelbooru.com/images/abc.png')
            self.assertEqual(self.calls[-1].url.params['api_key'], 'k')
        finally:
            os.environ.pop('GELBOORU_API_KEY')
            os.environ.pop('GELBOORU_USER_ID')

    async def test_image_proxy_whitelist(self):
        r = await self.get('/proxy/booru/image', u='https://cdn.donmai.us/original/a.jpg')
        self.assertEqual((r.status_code, r.content, r.headers['content-type']), (200, JPG, 'image/jpeg'))
        self.assertIn('private', r.headers['cache-control'])
        for bad in ('https://evil.example/a.jpg', 'http://cdn.donmai.us/a.jpg', 'https://u:p@cdn.donmai.us/a.jpg',
                    'https://cdn.donmai.us.evil.example/a.jpg', 'file:///etc/passwd', 'https://127.0.0.1/a.jpg'):
            self.assertEqual((await self.get('/proxy/booru/image', u=bad)).status_code, 400, bad)
        self.assertEqual((await self.get('/proxy/booru/image', u='https://cdn.donmai.us/html')).status_code, 502)
        self.assertEqual((await self.get('/proxy/booru/image', u='https://cdn.donmai.us/big.jpg')).status_code, 413)

    async def test_favorites_storage_kind(self):
        old = m.user_data.root
        m.user_data.root = Path(tempfile.mkdtemp())
        self.addCleanup(setattr, m.user_data, 'root', old)
        r = await self.client.put('/proxy/userdata/booru', json={'rev': 0, 'data': {'items': []}}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)


if __name__ == '__main__':
    unittest.main()
