import { h, safeStorage } from './util.js';
const $ = (selector) => document.querySelector(selector);
const storage = 'nai-studio:key';
let key = safeStorage(storage) || '', state = null, busy = false;

function notice(text, error = false) {
  $('#notice').textContent = text;
  $('#notice').hidden = !text;
  $('#notice').classList.toggle('error', error);
}
function showLogin() {
  state = null;
  $('#dashboard').hidden = true;
  $('#auth').hidden = false;
  $('#logout').hidden = true;
  $('#owner-name').textContent = '';
  $('#keys').replaceChildren();
  $('#pst').value = '';
  $('#secret').close();
}
async function api(path = '', body, method) {
  const response = await fetch('/proxy/manage' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'omit',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) showLogin();
    throw new Error(result.detail || result.message || '请求失败');
  }
  return result;
}
function run(action) {
  return async (event) => {
    event?.preventDefault();
    if (busy) return;
    busy = true;
    notice('');
    const button = event?.submitter || event?.currentTarget;
    const disabled = button?.disabled;
    if (button?.tagName === 'BUTTON') button.disabled = true;
    try { await action(); } catch (error) { notice(error.message, true); }
    finally { busy = false; if (button?.tagName === 'BUTTON') button.disabled = disabled; }
  };
}
function subscription(value) {
  if (!value) return;
  const names = ['Paper', 'Tablet', 'Scroll', 'Opus'];
  const steps = value.trainingStepsLeft;
  const anlas = typeof steps === 'number' ? steps : (steps?.fixedTrainingStepsLeft || 0) + (steps?.purchasedTrainingSteps || 0);
  $('#subscription').textContent = `${names[value.tier] || '未知等级'} · ${value.active ? '订阅有效' : '未激活订阅'} · Anlas ${anlas.toLocaleString()}${value.checked_at ? ' · ' + new Date(value.checked_at).toLocaleString() : ''}`;
}
function secret(name, value) {
  $('#secret-name').textContent = name;
  $('#secret-value').value = value;
  $('#secret').showModal();
}
async function load() {
  state = await api();
  safeStorage(storage, key);
  $('#auth').hidden = true;
  $('#dashboard').hidden = false;
  $('#logout').hidden = false;
  $('#pst-mask').textContent = state.upstream;
  $('#owner-name').textContent = state.keys.find((item) => item.id === state.current_id)?.name + ' · 管理员';
  subscription(state.subscription);
  $('#keys').replaceChildren();
  for (const item of state.keys) {
    const actions = h('div', { class: 'row' });
    function button(label, action, disabled = false) {
      actions.append(h('button', { type: 'button', disabled, onclick: run(action) }, label));
    }
    button('查看 / 复制', async () => secret(item.name, (await api(`/keys/${item.id}/secret`)).key));
    button('改名', async () => {
      const name = prompt('新的使用者名称', item.name);
      if (name === null) return;
      await api(`/keys/${item.id}`, { name }, 'PATCH'); await load();
    });
    button(item.enabled ? '停用' : '启用', async () => {
      await api(`/keys/${item.id}`, { enabled: !item.enabled }, 'PATCH'); await load();
    }, item.owner);
    button('轮换', async () => {
      if (!confirm(`轮换 ${item.name} 的 Key？旧 Key 将立即失效。`)) return;
      const replacement = prompt('填写新 Key（至少 10 位）；留空自动生成', '');
      if (replacement === null) return;
      const result = await api(`/keys/${item.id}/rotate`, { key: replacement.trim() });
      await load(); secret(item.name, result.key);
    }, item.owner);
    button('删除', async () => {
      if (prompt(`输入名称「${item.name}」确认删除此 Key`) !== item.name) return;
      await api(`/keys/${item.id}`, {}, 'DELETE'); await load();
    }, item.owner);
    $('#keys').append(h('tr', {}, h('td', {}, item.name), h('td', {}, item.owner ? '管理员' : '生图'),
      h('td', {}, item.enabled ? '已启用' : '已停用'), h('td', {}, h('code', {}, item.masked)), h('td', {}, actions)));
  }
}
async function check() {
  const result = await api('/upstream/check', {});
  subscription(result.subscription);
  $('#pst-mask').textContent = result.upstream;
}
$('#login').onsubmit = run(async () => {
  key = $('#login-key').value.trim();
  try { await load(); await check(); } finally { $('#login-key').value = ''; }
});
$('#upstream').onsubmit = run(async () => {
  try {
    await api('/upstream', { token: $('#pst').value.trim() });
    await load(); notice('官方 PST 已更新并验证，即时生效。');
  } finally { $('#pst').value = ''; }
});
$('#create').onsubmit = run(async () => {
  try {
    const result = await api('/keys', { name: $('#new-name').value.trim(), key: $('#custom-key').value.trim() });
    $('#new-name').value = ''; await load(); secret(result.name, result.key);
  } finally { $('#custom-key').value = ''; }
});
$('#check').onclick = run(check);
$('#close').onclick = () => $('#secret').close();
$('#secret').addEventListener('close', () => { $('#secret-value').value = ''; });
$('#copy').onclick = run(async () => {
  try { await navigator.clipboard.writeText($('#secret-value').value); notice('Key 已复制。'); }
  catch { $('#secret-value').select(); notice('请使用复制快捷键复制所选 Key。'); }
});
$('#logout').onclick = () => { key = ''; safeStorage(storage, null); showLogin(); };
if (key) run(async () => { await load(); await check(); })();
