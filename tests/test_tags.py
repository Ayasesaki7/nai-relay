import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

os.environ.update(NAI_TOKEN='pst-synthetic-' + 'x' * 24, PROXY_KEYS='me:owner10425,friend:member-test-key-12345', DOMAIN='nai.test')
os.environ.setdefault('LOG_DIR', tempfile.mkdtemp())
os.environ.setdefault('TAG_DICT_URL', '')
os.environ.setdefault('TAG_DICT_FILE', str(Path(tempfile.mkdtemp()) / 'tags.sqlite'))
import httpx
from app import main as m
from app.tags import TagDict, normalize

MEMBER = 'member-test-key-12345'
ROWS = [
    ('1girl', 0, '一个女孩', 8600000),
    ('long_hair', 0, '长发', 6300000),
    ('very_long_hair', 0, '超长发', 1600000),
    ('hair_ornament', 0, '发饰', 2100000),
    ('hatsune_miku', 4, '初音未来（VOCALOID）', 148000),
    ('miku_day', 0, '初音日', 2700),
    ('vocaloid', 3, 'VOCALOID', 214000),
    ('o_o', 0, 'o_o（圆眼）', 29000),
    ('100%_orange_juice', 3, '100%鲜橙汁', 3000),
]


def make_dict(path):
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE tags (name TEXT PRIMARY KEY, category INTEGER, cn_name TEXT, post_count INTEGER)')
    conn.executemany('INSERT INTO tags VALUES (?,?,?,?)', ROWS)
    conn.commit()
    conn.close()


class DictTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.path = Path(d.name) / 'tags.sqlite'
        self.dict = TagDict(self.path)
        self.addCleanup(lambda: self.dict._conn and self.dict._conn.close())

    def test_missing_file_is_not_ready(self):
        self.assertFalse(self.dict.open())
        self.assertFalse(self.dict.ready)
        self.assertEqual(self.dict.search('hair'), [])

    def test_search_ranking_and_filters(self):
        make_dict(self.path)
        self.assertTrue(self.dict.open())
        self.assertEqual(self.dict.count, len(ROWS))
        names = [r['name'] for r in self.dict.search('long hair')]
        self.assertEqual(names[0], 'long_hair')  # 完全一致排最前
        self.assertIn('very_long_hair', names)
        # 单词开头匹配（hatsune_miku）排在只是包含的前面，再按热度
        self.assertEqual([r['name'] for r in self.dict.search('miku')], ['hatsune_miku', 'miku_day'])
        self.assertEqual(self.dict.search('长发')[0], {'name': 'long_hair', 'cat': 0, 'cn': '长发', 'count': 6300000})
        self.assertEqual([r['name'] for r in self.dict.search('初音', cat=4)], ['hatsune_miku'])
        # LIKE 通配符要当普通字符
        self.assertEqual([r['name'] for r in self.dict.search('100%')], ['100%_orange_juice'])
        self.assertEqual([r['name'] for r in self.dict.search('o_o')], ['o_o'])

    def test_lookup_normalizes_prompt_spelling(self):
        make_dict(self.path)
        self.dict.open()
        got = self.dict.lookup(['Long Hair', '{{hatsune miku}}', '1.2::1girl::', 'nothing here'])
        self.assertEqual(sorted(got), ['1girl', 'hatsune_miku', 'long_hair'])
        self.assertEqual(normalize(' -0.5::Blue Eyes:: '), 'blue_eyes')


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        make_dict(Path(d.name) / 'tags.sqlite')
        m.control.path = Path(d.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = 'pst-synthetic-' + 'x' * 24, {'owner10425': 'me', MEMBER: 'friend'}
        m.control.load()
        self.old_path = m.tag_dict.path
        m.tag_dict.path = Path(d.name) / 'tags.sqlite'
        m.tag_dict.open()
        self.calls = []

        async def danbooru(request):
            self.calls.append(request)
            p = request.url.path
            if p == '/related_tag.json':
                return httpx.Response(200, json={'related_tags': [
                    {'tag': {'name': 'hatsune_miku', 'category': 4, 'post_count': 148000}},
                    {'tag': {'name': 'vocaloid', 'category': 3, 'post_count': 214000}},
                    {'tag': {'name': 'unknown_tag', 'category': 0, 'post_count': 12}}]})
            if p == '/tag_aliases.json':
                if 'consequent_name' in str(request.url):
                    return httpx.Response(200, json=[{'antecedent_name': 'miku', 'status': 'active'},
                                                     {'antecedent_name': '/hm', 'status': 'deleted'}])
                return httpx.Response(200, json=[])
            if p.startswith('/wiki_pages/'):
                return httpx.Response(200, json={'other_names': ['初音ミク'], 'is_deleted': False})
            return httpx.Response(404)

        self.old_client = getattr(m, 'client', None)
        m.client = httpx.AsyncClient(transport=httpx.MockTransport(danbooru))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')
        self.auth = {'Authorization': 'Bearer ' + MEMBER}

    async def asyncTearDown(self):
        await self.client.aclose()
        await m.client.aclose()
        m.client = self.old_client
        m.tag_dict._conn.close()
        m.tag_dict._conn = None
        m.tag_dict.path = self.old_path

    async def test_requires_key(self):
        for method, path in [('GET', '/proxy/tags/search?q=hair'), ('POST', '/proxy/tags/lookup'),
                             ('GET', '/proxy/tags/detail?name=x'), ('GET', '/proxy/tags/status')]:
            self.assertEqual((await self.client.request(method, path)).status_code, 401, path)

    async def test_search_and_lookup(self):
        res = (await self.client.get('/proxy/tags/search', params={'q': '长发', 'limit': 5}, headers=self.auth)).json()
        self.assertTrue(res['ready'])
        self.assertEqual(res['items'][0]['name'], 'long_hair')
        self.assertEqual((await self.client.get('/proxy/tags/search?q=x&cat=2', headers=self.auth)).status_code, 400)
        res = (await self.client.post('/proxy/tags/lookup', json={'names': ['long hair', 'vocaloid']}, headers=self.auth)).json()
        self.assertEqual(res['items']['long_hair']['cn'], '长发')
        self.assertEqual(res['items']['vocaloid']['cat'], 3)

    async def test_detail_merges_danbooru_and_caches(self):
        res = (await self.client.get('/proxy/tags/detail', params={'name': 'Miku Day'}, headers=self.auth)).json()
        self.assertEqual(res['tag']['cn'], '初音日')
        self.assertEqual(res['aliases'], ['miku'])
        self.assertEqual(res['other_names'], ['初音ミク'])
        self.assertEqual([(r['name'], r['cn']) for r in res['related']],
                         [('hatsune_miku', '初音未来（VOCALOID）'), ('vocaloid', 'VOCALOID'), ('unknown_tag', '')])
        self.assertIsNone(res['remote_error'])
        self.assertTrue(all(r.headers['user-agent'] == 'nai-relay/1.0' for r in self.calls))
        n = len(self.calls)
        await self.client.get('/proxy/tags/detail', params={'name': 'miku_day'}, headers=self.auth)
        self.assertEqual(len(self.calls), n)  # 第二次走缓存

    async def test_detail_survives_danbooru_outage(self):
        await m.client.aclose()
        m.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
        res = (await self.client.get('/proxy/tags/detail', params={'name': 'vocaloid'}, headers=self.auth)).json()
        self.assertEqual(res['tag']['cn'], 'VOCALOID')
        self.assertEqual(res['related'], [])
        self.assertTrue(res['remote_error'])


if __name__ == '__main__':
    unittest.main()
