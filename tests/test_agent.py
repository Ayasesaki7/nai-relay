import base64
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
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from app import main as m
from app import agent as a

OWNER, MEMBER = 'owner10425', 'member-test-key-12345'
DS_KEY = 'sk-deepseek-synthetic-0001'
PRIV = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SA = {'type': 'service_account', 'project_id': 'demo-proj-1', 'private_key_id': 'kid1', 'client_email': 'bot@demo-proj-1.iam.gserviceaccount.com',
      'private_key': PRIV.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}


def sse(*objs, done=True):
    out = ''.join('data: ' + json.dumps(o) + '\n\n' for o in objs)
    return (out + ('data: [DONE]\n\n' if done else '')).encode()


def unb64(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        m.control.path = Path(d.name) / 'control.json'
        m.control.seed_token, m.control.seed_keys = 'pst-synthetic-' + 'x' * 24, {OWNER: 'me', MEMBER: 'friend'}
        m.control.load()
        old_store = m.agent_store.path
        m.agent_store.path, m.agent_store._data = Path(d.name) / 'agent.json', None
        self.addCleanup(setattr, m.agent_store, 'path', old_store)
        self.calls = []
        self.token_requests = 0

        def upstream(req: httpx.Request):
            self.calls.append(req)
            u = req.url
            if u.host == 'api.deepseek.com':
                if req.headers['authorization'] != 'Bearer ' + DS_KEY:
                    return httpx.Response(401, json={'error': {'message': f'Authentication Fails, your api key: {req.headers["authorization"][7:]} is invalid'}})
                if u.path == '/models':
                    return httpx.Response(200, json={'object': 'list', 'data': [{'id': 'deepseek-chat'}, {'id': 'deepseek-reasoner'}]})
                return httpx.Response(200, content=sse(
                    {'choices': [{'index': 0, 'delta': {'role': 'assistant', 'reasoning_content': '想一下'}}]},
                    {'choices': [{'index': 0, 'delta': {'content': '好的，'}}]},
                    {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'call_a', 'type': 'function', 'function': {'name': 'search_tags', 'arguments': '{"que'}}]}}]},
                    {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': 'ry": "猫耳"}'}}]}}]},
                    {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 1, 'id': 'call_b', 'type': 'function', 'function': {'name': 'inspect_creation', 'arguments': ''}}]}}]},
                    {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]},
                    {'choices': [], 'usage': {'prompt_tokens': 120, 'completion_tokens': 30}},
                ), headers={'content-type': 'text/event-stream'})
            if u.host == 'oauth2.googleapis.com':
                self.token_requests += 1
                form = dict(x.split('=', 1) for x in req.content.decode().split('&'))
                head, claims, sig = form['assertion'].split('.')
                PRIV.public_key().verify(unb64(sig), f'{head}.{claims}'.encode(), padding.PKCS1v15(), hashes.SHA256())
                c = json.loads(unb64(claims))
                assert c['iss'] == SA['client_email'] and c['aud'] == a.TOKEN_URL and json.loads(unb64(head))['kid'] == 'kid1'
                return httpx.Response(200, json={'access_token': 'ya29.synthetic', 'expires_in': 3600})
            if u.host.endswith('aiplatform.googleapis.com'):
                if req.headers.get('authorization') != 'Bearer ya29.synthetic' and req.headers.get('x-goog-api-key') != 'AQ.express-synthetic':
                    return httpx.Response(403, json=[{'error': {'code': 403, 'message': 'Permission denied'}}])
                if 'publishers/google/models' in u.path and not u.path.endswith('streamGenerateContent'):
                    return httpx.Response(200, json={'publisherModels': [{'name': 'publishers/google/models/gemini-2.5-pro'},
                                                                         {'name': 'publishers/google/models/imagen-4'}]})
                return httpx.Response(200, content=sse(
                    {'candidates': [{'content': {'role': 'model', 'parts': [{'text': '先看看', 'thought': True}]}}]},
                    {'candidates': [{'content': {'role': 'model', 'parts': [{'text': '我来查'}]}}]},
                    {'candidates': [{'content': {'role': 'model', 'parts': [{'functionCall': {'name': 'search_tags', 'args': {'query': 'cat'}}, 'thoughtSignature': 'SIG1'}]},
                                     'finishReason': 'STOP'}], 'usageMetadata': {'promptTokenCount': 50, 'candidatesTokenCount': 9}},
                    done=False), headers={'content-type': 'text/event-stream'})
            if u.host == 'llm.example.com':
                return httpx.Response(500, text='boom')
            return httpx.Response(404)

        self.old_client = getattr(m, 'client', None)
        m.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url='https://nai.test')

        async def no_dns(url):
            if 'internal-looking' in url:
                raise a.Bad(400, 'API 地址不能指向内网')
        self.old_resolve = a._resolve_public
        a._resolve_public = no_dns

    async def asyncTearDown(self):
        a._resolve_public = self.old_resolve
        await self.client.aclose()
        await m.client.aclose()
        m.client = self.old_client

    def h(self, key):
        return {'Authorization': 'Bearer ' + key}

    async def add(self, who, **body):
        return await self.client.post('/proxy/agent/connections', json=body, headers=self.h(who))

    async def chat(self, key, conn, messages=None, **extra):
        body = {'conn': conn, 'system': '你是助手', 'messages': messages or [{'role': 'user', 'text': '你好'}],
                'tools': [{'name': 'search_tags', 'description': '查 TAG', 'parameters': {'type': 'object', 'properties': {'query': {'type': 'string'}},
                                                                                     'required': ['query'], 'additionalProperties': False}}], **extra}
        r = await self.client.post('/proxy/agent/chat', json=body, headers=self.h(key))
        events = [json.loads(line[6:]) for line in r.text.split('\n') if line.startswith('data: ')] if r.status_code == 200 else None
        return r, events

    async def test_requires_key(self):
        for method, p in (('GET', '/proxy/agent/config'), ('POST', '/proxy/agent/connections'), ('POST', '/proxy/agent/chat')):
            self.assertEqual((await self.client.request(method, p, json={})).status_code, 401, p)

    async def test_connection_crud_never_echoes_key(self):
        r = await self.add(MEMBER, preset='deepseek', name='我的 DS', key=DS_KEY)
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()
        self.assertNotIn(DS_KEY, r.text)
        self.assertEqual((c['base_url'], c['model'], c['key_hint'], c['mine']), ('https://api.deepseek.com', 'deepseek-chat', '…0001', True))
        cfg = (await self.client.get('/proxy/agent/config', headers=self.h(MEMBER))).json()
        self.assertEqual([x['id'] for x in cfg['connections']], [c['id']])
        self.assertIn('deepseek', cfg['presets'])
        self.assertFalse(cfg['is_admin'])
        self.assertNotIn(DS_KEY, json.dumps(cfg))
        # 别人看不到、改不了
        self.assertEqual((await self.client.get('/proxy/agent/config', headers=self.h(OWNER))).json()['connections'], [])
        self.assertEqual((await self.client.patch(f'/proxy/agent/connections/{c["id"]}', json={'name': 'x'}, headers=self.h(OWNER))).status_code, 404)
        # key 留空 = 沿用
        r = await self.client.patch(f'/proxy/agent/connections/{c["id"]}', json={'name': '改名', 'model': 'deepseek-reasoner', 'key': ''}, headers=self.h(MEMBER))
        self.assertEqual((r.status_code, r.json()['name'], r.json()['key_hint']), (200, '改名', '…0001'))
        self.assertEqual(json.loads(m.agent_store.path.read_text(encoding='utf-8'))['connections'][0]['key'], DS_KEY)
        if os.name != 'nt':
            self.assertEqual(m.agent_store.path.stat().st_mode & 0o777, 0o600)
        r = await self.client.get(f'/proxy/agent/connections/{c["id"]}/models', headers=self.h(MEMBER))
        self.assertEqual(r.json()['items'], ['deepseek-chat', 'deepseek-reasoner'])
        self.assertEqual((await self.client.delete(f'/proxy/agent/connections/{c["id"]}', headers=self.h(OWNER))).status_code, 404)
        self.assertEqual((await self.client.delete(f'/proxy/agent/connections/{c["id"]}', headers=self.h(MEMBER))).status_code, 200)
        self.assertEqual((await self.client.get('/proxy/agent/config', headers=self.h(MEMBER))).json()['connections'], [])

    async def test_validation_and_url_rules(self):
        bad = [dict(preset='deepseek'),  # 没 key
               dict(preset='nope', key='k' * 20),
               dict(preset='deepseek', key='k' * 20, extra=1),
               dict(preset='deepseek', key='has space key'),
               dict(preset='openai', key='k' * 20, base_url='http://api.example.com/v1'),  # 普通用户必须 https
               dict(preset='openai', key='k' * 20, base_url='https://127.0.0.1/v1'),
               dict(preset='openai', key='k' * 20, base_url='https://169.254.169.254/v1'),
               dict(preset='openai', key='k' * 20, base_url='https://localhost/v1'),
               dict(preset='openai', key='k' * 20, base_url='https://nai-proxy:8000/v1'),
               dict(preset='openai', key='k' * 20, base_url='https://u:p@api.example.com/v1'),
               dict(preset='vertex', key='{"type":"user"}', model='gemini-2.5-pro'),
               dict(preset='vertex', auth='key', key='AQ.x' * 3, model='gemini 2.5', location='global'),
               dict(preset='vertex', auth='key', key='AQ.xxxxxxxx', location='US Central')]
        for body in bad:
            r = await self.add(MEMBER, **body)
            self.assertEqual(r.status_code, 400, (body, r.text))
        r = await self.add(MEMBER, preset='openai', key='sk-or-synthetic-123456', base_url='https://openrouter.ai/api/v1/', model='openai/gpt-5')
        self.assertEqual((r.status_code, r.json()['base_url']), (200, 'https://openrouter.ai/api/v1'))
        cid = r.json()['id']
        # 换地址必须重填 key
        r = await self.client.patch(f'/proxy/agent/connections/{cid}', json={'base_url': 'https://api.openai.com/v1'}, headers=self.h(MEMBER))
        self.assertEqual(r.status_code, 400)
        self.assertIn('重新填写 key', r.json()['message'])
        r = await self.client.patch(f'/proxy/agent/connections/{cid}', json={'base_url': 'https://api.openai.com/v1', 'key': 'sk-new-synthetic-99'}, headers=self.h(MEMBER))
        self.assertEqual(r.status_code, 200)
        # 普通用户不能共享
        r = await self.add(MEMBER, preset='deepseek', key=DS_KEY, shared=True)
        self.assertEqual(r.status_code, 403)
        # 管理员可以用 http（本机测试用）
        r = await self.add(OWNER, preset='openai', key='k' * 20, base_url='http://127.0.0.1:9/v1', model='x')
        self.assertEqual(r.status_code, 200, r.text)

    async def test_openai_stream_and_request_format(self):
        cid = (await self.add(MEMBER, preset='deepseek', key=DS_KEY)).json()['id']
        img = {'mime': 'image/png', 'data': base64.b64encode(b'\x89PNG fake').decode()}
        msgs = [{'role': 'user', 'text': '旧问题'},
                {'role': 'assistant', 'text': '旧回答', 'reasoning': '旧思考'},
                {'role': 'user', 'text': '看看这张图', 'images': [img]},
                {'role': 'assistant', 'text': '', 'reasoning': '新思考', 'calls': [{'id': 'call_x', 'name': 'view_image', 'args': {'id': 'r1'}}]},
                {'role': 'tool', 'id': 'call_x', 'name': 'view_image', 'result': '{"ok":true}', 'images': [img]}]
        r, ev = await self.chat(MEMBER, cid, msgs)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.headers['content-type'].startswith('text/event-stream'))
        self.assertIn('no-transform', r.headers['cache-control'])
        self.assertEqual(ev, [{'t': 'think', 'd': '想一下'}, {'t': 'text', 'd': '好的，'},
                              {'t': 'tool', 'id': 'call_a', 'name': 'search_tags', 'args': {'query': '猫耳'}},
                              {'t': 'tool', 'id': 'call_b', 'name': 'inspect_creation', 'args': {}},
                              {'t': 'done', 'finish': 'tool_calls', 'usage': {'in': 120, 'out': 30}}])
        body = json.loads(self.calls[-1].content)
        self.assertEqual(self.calls[-1].url, 'https://api.deepseek.com/chat/completions')
        self.assertEqual(self.calls[-1].headers['user-agent'], 'nai-relay/1.0')
        out = body['messages']
        self.assertEqual(out[0], {'role': 'system', 'content': '你是助手'})
        self.assertNotIn('reasoning_content', out[2])  # 上一轮的思考不带
        self.assertEqual(out[3]['content'][1]['image_url']['url'][:22], 'data:image/png;base64,')
        self.assertEqual(out[4]['reasoning_content'], '新思考')  # 这一轮调工具时的思考要带
        self.assertEqual(out[4]['tool_calls'][0]['function'], {'name': 'view_image', 'arguments': '{"id": "r1"}'})
        self.assertEqual(out[5], {'role': 'tool', 'tool_call_id': 'call_x', 'content': '{"ok":true}'})
        self.assertEqual(out[6]['role'], 'user')  # 工具返回的图片补在后面
        self.assertEqual(out[6]['content'][1]['type'], 'image_url')
        self.assertEqual(body['tools'][0]['function']['name'], 'search_tags')
        self.assertTrue(body['stream'])

    async def test_upstream_errors_hide_key(self):
        cid = (await self.add(MEMBER, preset='deepseek', key=DS_KEY)).json()['id']
        store = json.loads(m.agent_store.path.read_text(encoding='utf-8'))
        store['connections'][0]['key'] = 'sk-wrong-synthetic-key-777'
        m.agent_store.path.write_text(json.dumps(store), encoding='utf-8')
        m.agent_store._data = None
        r, _ = await self.chat(MEMBER, cid)
        self.assertEqual(r.status_code, 502)
        self.assertIn('拒绝了这个 key', r.json()['message'])
        self.assertNotIn('sk-wrong-synthetic-key-777', r.text)
        oid = (await self.add(OWNER, preset='openai', key='k' * 20, base_url='https://llm.example.com/v1', model='x')).json()['id']
        r, _ = await self.chat(OWNER, oid)
        self.assertEqual((r.status_code, r.json()['message']), (502, '大模型服务出错（500）：boom'))
        for msgs in ([{'role': 'system', 'text': 'x'}], [{'role': 'user', 'images': [{'mime': 'image/svg+xml', 'data': 'x'}]}], []):
            r, _ = await self.chat(OWNER, oid, msgs) if msgs else (await self.client.post('/proxy/agent/chat', json={'conn': oid, 'messages': []}, headers=self.h(OWNER)), None)
            self.assertEqual(r.status_code, 400, msgs)
        many = [{'role': 'user', 'images': [{'mime': 'image/png', 'data': 'AA=='}] * 25}]
        r, _ = await self.chat(OWNER, oid, many)
        self.assertEqual(r.status_code, 400)
        r, _ = await self.chat(OWNER, 'missing')
        self.assertEqual(r.status_code, 404)

    async def test_vertex_service_account(self):
        r = await self.add(MEMBER, preset='vertex', key=json.dumps(SA), model='gemini-2.5-pro', location='us-central1')
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()
        self.assertEqual((c['project'], c['key_hint'], c['auth']), ('demo-proj-1', SA['client_email'], 'sa'))
        self.assertNotIn('PRIVATE KEY', r.text)
        msgs = [{'role': 'user', 'text': '画只猫'},
                {'role': 'assistant', 'text': '', 'calls': [{'id': 'c1', 'name': 'search_tags', 'args': {'query': 'cat'}, 'sig': 'OLD'}]},
                {'role': 'tool', 'id': 'c1', 'result': '[]', 'images': [{'mime': 'image/jpeg', 'data': 'AA=='}]}]
        r, ev = await self.chat(MEMBER, c['id'], msgs)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(ev[0], {'t': 'think', 'd': '先看看'})
        self.assertEqual(ev[1], {'t': 'text', 'd': '我来查'})
        self.assertEqual((ev[2]['t'], ev[2]['name'], ev[2]['args'], ev[2]['sig']), ('tool', 'search_tags', {'query': 'cat'}, 'SIG1'))
        self.assertEqual(ev[3], {'t': 'done', 'finish': 'STOP', 'usage': {'in': 50, 'out': 9}})
        req = self.calls[-1]
        self.assertEqual(str(req.url), 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-proj-1/locations/us-central1'
                                       '/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
        body = json.loads(req.content)
        self.assertEqual(body['systemInstruction'], {'parts': [{'text': '你是助手'}]})
        self.assertEqual([x['role'] for x in body['contents']], ['user', 'model', 'user'])
        self.assertEqual(body['contents'][1]['parts'][0], {'functionCall': {'name': 'search_tags', 'args': {'query': 'cat'}}, 'thoughtSignature': 'OLD'})
        self.assertEqual(body['contents'][2]['parts'][0]['functionResponse'], {'name': 'search_tags', 'response': {'result': '[]'}})
        self.assertEqual(body['contents'][2]['parts'][1], {'inlineData': {'mimeType': 'image/jpeg', 'data': 'AA=='}})
        params = body['tools'][0]['functionDeclarations'][0]['parameters']
        self.assertEqual(params, {'type': 'OBJECT', 'properties': {'query': {'type': 'STRING'}}, 'required': ['query']})  # 去掉 additionalProperties
        # token 缓存：第二次不再登录
        await self.chat(MEMBER, c['id'])
        self.assertEqual(self.token_requests, 1)
        r = await self.client.get(f'/proxy/agent/connections/{c["id"]}/models', headers=self.h(MEMBER))
        self.assertEqual(r.json(), {'items': ['gemini-2.5-pro']})

    async def test_vertex_express_key_and_global(self):
        r = await self.add(MEMBER, preset='vertex', auth='key', key='AQ.express-synthetic', model='gemini-3-pro-preview')
        self.assertEqual(r.status_code, 200, r.text)
        r, ev = await self.chat(MEMBER, r.json()['id'])
        self.assertEqual(ev[-1]['t'], 'done')
        self.assertEqual(str(self.calls[-1].url), 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-pro-preview:streamGenerateContent?alt=sse')
        r = await self.add(MEMBER, preset='vertex', key=json.dumps(SA), model='gemini-2.5-flash')
        r, ev = await self.chat(MEMBER, r.json()['id'])
        self.assertTrue(str(self.calls[-1].url).startswith('https://aiplatform.googleapis.com/v1/projects/demo-proj-1/locations/global/'))

    async def test_shared_connection_daily_limit(self):
        r = await self.add(OWNER, preset='deepseek', key=DS_KEY, shared=True, daily_limit=2)
        self.assertEqual(r.status_code, 200, r.text)
        cid = r.json()['id']
        cfg = (await self.client.get('/proxy/agent/config', headers=self.h(MEMBER))).json()
        seen = cfg['connections'][0]
        self.assertEqual((seen['mine'], seen['shared'], seen['used_today']), (False, True, 0))
        self.assertNotIn('base_url', seen)
        self.assertNotIn('key_hint', seen)
        for _ in range(2):
            r, ev = await self.chat(MEMBER, cid)
            self.assertEqual(r.status_code, 200)
        r, _ = await self.chat(MEMBER, cid)
        self.assertEqual(r.status_code, 429)
        self.assertIn('上限', r.json()['message'])
        # 管理员自己用不计次
        for _ in range(3):
            self.assertEqual((await self.chat(OWNER, cid))[0].status_code, 200)
        self.assertEqual((await self.client.patch(f'/proxy/agent/connections/{cid}', json={'name': 'x'}, headers=self.h(MEMBER))).status_code, 403)
        self.assertEqual((await self.client.delete(f'/proxy/agent/connections/{cid}', headers=self.h(MEMBER))).status_code, 404)
        self.assertEqual((await self.client.get(f'/proxy/agent/connections/{cid}/models', headers=self.h(MEMBER))).status_code, 200)

    async def test_dns_guard(self):
        r = await self.add(MEMBER, preset='openai', key='k' * 20, base_url='https://internal-looking.example.com/v1', model='x')
        r, _ = await self.chat(MEMBER, r.json()['id'])
        self.assertEqual(r.status_code, 400)
        a._resolve_public = self.old_resolve
        import socket
        orig = socket.getaddrinfo
        socket.getaddrinfo = lambda *x, **k: [(2, 1, 6, '', ('10.1.2.3', 443))]
        try:
            with self.assertRaises(a.Bad):
                await a._resolve_public('https://rebind.example.com/v1')
        finally:
            socket.getaddrinfo = orig

    async def test_agent_userdata_kind(self):
        old = m.user_data.root
        m.user_data.root = Path(tempfile.mkdtemp())
        self.addCleanup(setattr, m.user_data, 'root', old)
        r = await self.client.put('/proxy/userdata/agent', json={'rev': 0, 'data': {'chats': []}}, headers=self.h(MEMBER))
        self.assertEqual(r.status_code, 200, r.text)

    async def test_shared_skills(self):
        old = m.user_data.root
        m.user_data.root = Path(tempfile.mkdtemp())
        self.addCleanup(setattr, m.user_data, 'root', old)
        md = '---\nname: 画风\ndescription: 换画风时用\n---\n\n步骤'
        skills = [{'id': 's1', 'shared': True, 'enabled': True, 'files': {'SKILL.md': md, 'refs/a.md': 'A'}},
                  {'id': 's2', 'shared': False, 'files': {'SKILL.md': md}},
                  {'id': 's3', 'shared': True, 'enabled': False, 'files': {'SKILL.md': md}},
                  {'id': 'bad id!', 'shared': True, 'files': {'SKILL.md': md}},
                  {'id': 's4', 'shared': True, 'files': {'SKILL.md': 3}},
                  {'id': 's5', 'shared': True, 'files': {'SKILL.md': md, 'big.md': 'x' * (300 << 10)}}]
        r = await self.client.put('/proxy/userdata/skills', json={'rev': 0, 'data': {'skills': skills}}, headers=self.h(OWNER))
        self.assertEqual(r.status_code, 200, r.text)
        # 普通用户「共享」的技能不会给别人
        await self.client.put('/proxy/userdata/skills', json={'rev': 0, 'data': {'skills': [{'id': 'm1', 'shared': True, 'files': {'SKILL.md': md}}]}},
                              headers=self.h(MEMBER))
        self.assertEqual((await self.client.get('/proxy/agent/skills')).status_code, 401)
        r = await self.client.get('/proxy/agent/skills', headers=self.h(MEMBER))
        items = r.json()['items']
        self.assertEqual([x['id'].split('-', 1)[1] for x in items], ['s1', 's5'])
        self.assertEqual(items[0]['owner'], 'me')
        self.assertEqual(items[0]['files'], {'SKILL.md': md, 'refs/a.md': 'A'})
        self.assertNotIn('big.md', items[1]['files'])
        # 管理员自己不会再收到一份
        r = await self.client.get('/proxy/agent/skills', headers=self.h(OWNER))
        self.assertEqual(r.json()['items'], [])


if __name__ == '__main__':
    unittest.main()
