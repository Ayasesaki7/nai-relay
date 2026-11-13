// 个人词库（收藏 / 分类 / 固定词 / 随机词）和提示词快照，保存在服务器上，按中转用户分开
import { h, icon, uid } from './util.js';
import { addTo, removeFrom, containsAll, splitPrompt, segKey } from './prompt.js';

const DEFAULT_CATS = [['c-role', '角色'], ['c-cloth', '服装'], ['c-act', '动作'], ['c-scene', '场景']];
const MAX_SNAPSHOTS = 200;
const MAX_AUTO = 5;
const str = (v, n = 20000) => (typeof v === 'string' ? v.slice(0, n) : '');

function normLib(d) {
  d = d && typeof d === 'object' ? d : {};
  const cats = Array.isArray(d.cats) ? d.cats.filter((c) => c && c.id && c.name).map((c) => ({ id: str(c.id, 40), name: str(c.name, 40) }))
    : DEFAULT_CATS.map(([id, name]) => ({ id, name }));
  const items = (Array.isArray(d.items) ? d.items : []).filter((x) => x && x.id && x.text)
    .map((x) => ({ id: str(x.id, 40), text: str(x.text), title: str(x.title, 80), cat: str(x.cat, 40), at: +x.at || 0 }));
  const presets = (Array.isArray(d.presets) ? d.presets : []).filter((x) => x && x.id)
    .map((x) => ({
      id: str(x.id, 40), name: str(x.name, 60), pos: str(x.pos), neg: str(x.neg), pin: !!x.pin, at: +x.at || 0,
      // 固定词生图时才拼到提示词前后，不写进编辑框；旧数据（以前是一键插入）默认不启用
      on: !!x.on, posEnd: !!x.posEnd, negEnd: !!x.negEnd,
    }));
  return { v: 1, cats, items, presets };
}

const edgeTrim = (t) => (t || '').trim().replace(/^[\s,]+|[\s,]+$/g, '');
const joinParts = (parts) => parts.map(edgeTrim).filter(Boolean).join(', ');

/** 启用的固定词，按正面 / 负面、前缀 / 后缀分好 */
export function fixedParts(presets) {
  const out = { pre: [], post: [], negPre: [], negPost: [] };
  for (const p of presets || []) {
    if (!p.on) continue;
    if (edgeTrim(p.pos)) out[p.posEnd ? 'post' : 'pre'].push(edgeTrim(p.pos));
    if (edgeTrim(p.neg)) out[p.negEnd ? 'negPost' : 'negPre'].push(edgeTrim(p.neg));
  }
  return out;
}

/** 把启用的固定词拼到正面 / 负面提示词前后（生图时用，编辑框里不出现） */
export function withFixed(src, presets) {
  const f = fixedParts(presets);
  if (!f.pre.length && !f.post.length && !f.negPre.length && !f.negPost.length) return src;
  return {
    ...src,
    prompt: joinParts([...f.pre, src.prompt || '', ...f.post]),
    negative: joinParts([...f.negPre, src.negative || '', ...f.negPost]),
  };
}

function stripEdges(text, pre, post) {
  let t = (text || '').trim();
  const cut = (v) => v.replace(/^[\s,]+|[\s,]+$/g, '');
  for (const x of pre) {
    if (t === x) t = '';
    else if (t.startsWith(x) && /^[\s,]/.test(t.slice(x.length))) t = cut(t.slice(x.length));
  }
  for (const x of [...post].reverse()) {
    if (t === x) t = '';
    else if (t.endsWith(x) && /[\s,]$/.test(t.slice(0, -x.length))) t = cut(t.slice(0, -x.length));
  }
  return t;
}

/** 取回旧图参数时，把当前启用的固定词从提示词两头去掉，免得生图时重复加 */
export function stripFixed(params, presets) {
  const f = fixedParts(presets);
  const out = { ...params };
  if (typeof out.prompt === 'string') out.prompt = stripEdges(out.prompt, f.pre, f.post);
  if (typeof out.negative === 'string') out.negative = stripEdges(out.negative, f.negPre, f.negPost);
  return out;
}

function normSnaps(d) {
  d = d && typeof d === 'object' ? d : {};
  const items = (Array.isArray(d.items) ? d.items : []).filter((x) => x && x.id && x.data && typeof x.data === 'object')
    .map((x) => ({ id: str(x.id, 40), name: str(x.name, 80), at: +x.at || 0, auto: !!x.auto, data: x.data }));
  return { v: 1, items };
}

/** 一份存在服务器上的文档：本地先改，攒一下再整份保存；别的设备改过（409）就拿最新的重放本地改动 */
export function createDoc({ api, kind, normalize, onChange, onError }) {
  const d = { kind, rev: 0, data: normalize(null), state: 'idle', gen: 0, pending: [], saving: false, timer: 0, failed: '' };
  const schedule = (ms) => { clearTimeout(d.timer); d.timer = setTimeout(flush, ms); };
  d.load = async () => {
    const gen = ++d.gen;
    clearTimeout(d.timer);
    Object.assign(d, { state: 'loading', pending: [], saving: false, failed: '' });
    onChange();
    try {
      const r = await api.userdataGet(kind);
      if (gen !== d.gen) return;
      Object.assign(d, { rev: r.rev, data: normalize(r.data), state: 'ready' });
    } catch (e) {
      if (gen !== d.gen) return;
      Object.assign(d, { state: 'error', failed: e.message });
    }
    onChange();
  };
  d.reset = () => {
    d.gen++;
    clearTimeout(d.timer);
    Object.assign(d, { rev: 0, data: normalize(null), state: 'idle', pending: [], saving: false, failed: '' });
  };
  d.mutate = (fn) => {
    if (d.state !== 'ready') {
      onError(d.state === 'loading' ? '还在从服务器载入，稍等一下' : '没能从服务器载入，打开词库重试');
      return false;
    }
    fn(d.data);
    d.pending.push(fn);
    onChange();
    schedule(400);
    return true;
  };
  async function flush() {
    if (d.saving || !d.pending.length || d.state !== 'ready') return;
    const gen = d.gen;
    const ops = d.pending.splice(0);
    let retry = 0;
    d.saving = true;
    onChange();
    try {
      const r = await api.userdataPut(kind, d.rev, d.data);
      if (gen !== d.gen) return;
      d.rev = r.rev;
      d.failed = '';
    } catch (e) {
      if (gen !== d.gen) return;
      const all = [...ops, ...d.pending];
      if (e.status === 409 && e.data?.current) {
        d.rev = e.data.current.rev;
        d.data = normalize(e.data.current.data);
        for (const op of all) op(d.data);
        retry = 30;
      } else {
        if (!d.failed) onError(`保存到服务器失败：${e.message}`);
        d.failed = e.message;
        retry = 15000;
      }
      d.pending = all;
    } finally {
      if (gen === d.gen) {
        d.saving = false;
        onChange();
        if (d.pending.length) schedule(retry || 30);
      }
    }
  }
  d.flushNow = () => schedule(0);
  /** 关页面时尽量把没存的发出去 */
  d.beacon = (key) => {
    if (!d.pending.length || d.state !== 'ready') return;
    try {
      fetch(`/proxy/userdata/${kind}`, {
        method: 'PUT', keepalive: true,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev: d.rev, data: d.data }),
      });
    } catch {}
  };
  d.status = () => {
    if (d.state === 'loading') return ['载入中…', ''];
    if (d.state === 'error') return [`载入失败：${d.failed}`, 'bad'];
    if (d.state !== 'ready') return ['', ''];
    if (d.failed) return [`未保存：${d.failed}`, 'bad'];
    if (d.saving || d.pending.length) return ['保存中…', ''];
    return ['已保存到服务器', 'ok'];
  };
  return d;
}

const fmtTime = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const same = d.toDateString() === new Date().toDateString();
  return `${same ? '' : `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()} `}${p(d.getHours())}:${p(d.getMinutes())}`;
};

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * deps: api, getKey, toast, openModal, confirmDialog, openMenu,
 *   targets(): [{ id, label, ta }]  能插入的输入框
 *   initialTarget(): 默认插入到哪个
 *   editPrompt(ta, value): 改输入框（记撤销）
 *   getPromptState() / applyPromptState(data): 快照读写
 *   cnOf(text)
 */
export function createLibrary(deps) {
  const { toast } = deps;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(); };
  const onError = (m) => toast(m, 'error', 5000);
  const lib = createDoc({ api: deps.api, kind: 'library', normalize: normLib, onChange: notify, onError });
  const snaps = createDoc({ api: deps.api, kind: 'snapshots', normalize: normSnaps, onChange: notify, onError });
  const ui = { close: null, tab: 'fav', q: '', cat: 'all', sel: null, edit: null, target: null, renaming: null };

  addEventListener('pagehide', () => { const k = deps.getKey(); if (k) { lib.beacon(k); snaps.beacon(k); } });

  const catName = (id) => lib.data.cats.find((c) => c.id === id)?.name || '';
  const findTarget = () => {
    const ts = deps.targets();
    return ts.find((t) => t.id === ui.target) || ts.find((t) => t.id === deps.initialTarget()) || ts[0];
  };

  // ---------- 对外 ----------

  function pickWild(name) {
    if (lib.state !== 'ready') return null;
    const cat = lib.data.cats.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (!cat) return null;
    const pool = lib.data.items.filter((x) => x.cat === cat.id);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)].text : '';
  }

  function addFavorite(text, cat) {
    text = text.trim();
    if (!text) return;
    const key = splitPrompt(text).map(segKey).join(',');
    const dup = lib.data.items.find((x) => x.cat === cat && splitPrompt(x.text).map(segKey).join(',') === key);
    if (dup) return toast(`「${catName(cat) || '未分类'}」里已经有了`);
    const item = { id: uid(), text, title: '', cat, at: Date.now() };
    if (lib.mutate((d) => { if (!d.items.some((x) => x.id === item.id)) d.items.unshift(item); })) {
      toast(`已收藏到「${catName(cat) || '未分类'}」`, 'ok');
    }
  }

  /** 点收藏按钮：弹出分类菜单选一个 */
  function quickFavorite(text, anchor) {
    if (!text?.trim()) return;
    if (lib.state !== 'ready') {
      if (lib.state !== 'loading') lib.load();
      return onError('词库还没载入，稍后再试');
    }
    deps.openMenu(anchor, [
      ...lib.data.cats.map((c) => ({ label: c.name, hint: `${lib.data.items.filter((x) => x.cat === c.id).length}`, run: () => addFavorite(text, c.id) })),
      { label: '未分类', run: () => addFavorite(text, '') },
    ]);
  }

  const presets = () => (lib.state === 'ready' ? lib.data.presets : []);
  const posLabel = (end) => (end ? '后缀' : '前缀');
  const presetTip = (p) => [
    p.pos ? `正面（${posLabel(p.posEnd)}）：${p.pos}` : '',
    p.neg ? `负面（${posLabel(p.negEnd)}）：${p.neg}` : '',
  ].filter(Boolean).join('\n');

  function setPresetOn(id, on) {
    lib.mutate((d) => { const x = d.presets.find((y) => y.id === id); if (x) x.on = on; });
  }

  /** 提示词下方的固定词条：启用的和置顶的都显示，点一下启用 / 停用 */
  function renderBar() {
    const bar = document.getElementById('preset-bar');
    if (!bar) return;
    bar.hidden = lib.state !== 'ready';
    if (bar.hidden) return bar.replaceChildren();
    const all = lib.data.presets;
    const shown = all.filter((p) => p.pin || p.on);
    const onN = all.filter((p) => p.on).length;
    bar.replaceChildren(
      h('button', {
        type: 'button', class: `chip small fixed-head${onN ? ' on' : ''}`,
        title: '固定词：生图时自动加到提示词前面或后面，不会出现在编辑框里。点击管理 / 修改',
        onclick: () => open('preset'),
      }, icon('pin', 12), '固定词', all.length ? h('small', {}, `${onN}/${all.length}`) : null),
      ...shown.map((p) => h('button', {
        type: 'button', class: `chip small${p.on ? ' on' : ''}`, 'data-id': p.id,
        title: `${presetTip(p)}\n点击${p.on ? '停用' : '启用'}`,
        onclick: () => setPresetOn(p.id, !p.on),
      }, h('i', { class: 'fx-dot' }), p.name || '未命名')));
  }

  // ---------- 快照 ----------

  const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function saveSnapshot(name, auto = false) {
    const data = structuredClone(deps.getPromptState());
    const manual = snaps.data.items.filter((x) => !x.auto).length;
    if (!auto && manual >= MAX_SNAPSHOTS) return onError(`快照最多 ${MAX_SNAPSHOTS} 个，先删掉一些`);
    const item = { id: uid(), name: name || fmtTime(Date.now()), at: Date.now(), auto, data };
    return snaps.mutate((d) => {
      if (d.items.some((x) => x.id === item.id)) return;
      d.items.unshift(item);
      const autos = d.items.filter((x) => x.auto);
      if (autos.length > MAX_AUTO) {
        const drop = new Set(autos.slice(MAX_AUTO).map((x) => x.id));
        d.items = d.items.filter((x) => !drop.has(x.id));
      }
    });
  }

  function restoreSnapshot(s) {
    const now = deps.getPromptState();
    if (sameState(now, s.data)) return toast('当前内容和这个快照一样');
    // 恢复前先把当前内容自动存一份，免得误点丢掉
    const latest = snaps.data.items[0];
    const backed = (latest && sameState(latest.data, now)) || snaps.data.items.some((x) => sameState(x.data, now)) || saveSnapshot('恢复前自动保存', true);
    deps.applyPromptState(structuredClone(s.data));
    toast(backed ? `已恢复「${s.name}」` : `已恢复「${s.name}」（当前内容没能备份）`, 'ok');
    renderBar();
  }

  // ---------- 弹窗 ----------

  const search = h('input', { type: 'search', class: 'lib-search', placeholder: '搜索收藏…', spellcheck: 'false' });
  search.addEventListener('input', () => { ui.q = search.value; paint(); });
  const statusEl = h('span', { class: 'lib-status' });
  const tabsEl = h('div', { class: 'seg small lib-tabs' });
  const pane = h('div', { class: 'lib-pane' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) importFile(f); });

  function open(tab) {
    if (tab) ui.tab = tab;
    if (lib.state === 'error' || lib.state === 'idle') lib.load();
    if (snaps.state === 'error' || snaps.state === 'idle') snaps.load();
    if (ui.close) return paint();
    ui.target = null;
    ui.sel = null;
    ui.edit = null;
    const opts = {
      title: '个人词库',
      wide: true,
      cls: 'lib-modal',
      body: h('div', { class: 'lib' }, h('div', { class: 'lib-top' }, tabsEl, statusEl), pane, fileIn),
      onClose: () => { ui.close = null; lib.flushNow(); snaps.flushNow(); },
    };
    ui.close = deps.openPage?.(opts) || deps.openModal(opts);
    paint();
  }

  listeners.add(() => {
    renderBar();
    if (ui.close) paint();
  });

  function paint() {
    const sts = [lib.status(), snaps.status()];
    const [msg, cls] = sts.find((s) => s[1] === 'bad') || sts.find((s) => s[0] && !s[1]) || sts[0];
    statusEl.textContent = msg;
    statusEl.className = `lib-status ${cls}`;
    const tabs = [['fav', '收藏', lib.data.items.length], ['preset', '固定词', lib.data.presets.length], ['snap', '快照', snaps.data.items.length]];
    tabsEl.replaceChildren(...tabs.map(([id, label, n]) => h('button', {
      type: 'button', class: ui.tab === id ? 'on' : '', 'data-tab': id,
      onclick: () => { ui.tab = id; ui.sel = null; ui.edit = null; paint(); },
    }, label, n ? h('small', {}, n) : null)));
    const doc = ui.tab === 'snap' ? snaps : lib;
    if (doc.state === 'loading' || doc.state === 'idle') return pane.replaceChildren(h('div', { class: 'lib-empty' }, '载入中…'));
    if (doc.state === 'error') {
      return pane.replaceChildren(h('div', { class: 'lib-empty' }, `载入失败：${doc.failed}`, h('br'),
        h('button', { type: 'button', class: 'btn small', onclick: () => doc.load() }, '重试')));
    }
    const keepFocus = document.activeElement === search;
    pane.replaceChildren(...(ui.tab === 'fav' ? favPane() : ui.tab === 'preset' ? presetPane() : snapPane()).filter(Boolean));
    if (keepFocus) search.focus();
  }

  function targetRow() {
    const ts = deps.targets();
    const t = findTarget();
    return h('div', { class: 'lib-targets' }, h('span', { class: 'muted' }, '点击插入到'),
      ...ts.map((x) => h('button', {
        type: 'button', class: `chip small${x === t ? ' on' : ''}`, onclick: () => { ui.target = x.id; paint(); },
      }, x.label)));
  }

  // ---- 收藏 ----

  function favPane() {
    const { cats, items } = lib.data;
    const q = ui.q.trim().toLowerCase();
    const inCat = (x) => ui.cat === 'all' || x.cat === ui.cat || (ui.cat === '' && !cats.some((c) => c.id === x.cat));
    const list = items.filter((x) => inCat(x) && (!q || x.text.toLowerCase().includes(q) || x.title.toLowerCase().includes(q) || deps.cnOf(x.text).includes(q)));
    const count = (id) => items.filter((x) => (id === '' ? !cats.some((c) => c.id === x.cat) : x.cat === id)).length;
    const t = findTarget();
    const curCat = cats.find((c) => c.id === ui.cat);

    const tools = h('div', { class: 'lib-tools' }, search,
      h('button', { type: 'button', class: 'btn small primary', onclick: () => { ui.edit = { id: null, text: '', title: '', cat: curCat ? curCat.id : '' }; paint(); } }, icon('plus', 14), '新建'),
      h('button', { type: 'button', class: `btn small ghost${ui.sel ? ' on' : ''}`, onclick: () => { ui.sel = ui.sel ? null : new Set(); paint(); } }, ui.sel ? '完成' : '批量'),
      h('button', { type: 'button', class: 'icon-btn', title: '导入 / 导出', onclick: (e) => ioMenu(e.currentTarget) }, icon('download', 16)));

    const catChip = (id, label, n) => h('button', {
      type: 'button', class: `chip small${ui.cat === id ? ' on' : ''}`, 'data-cat': id,
      onclick: () => { ui.cat = id; ui.sel &&= new Set(); paint(); },
    }, label, h('small', {}, n));
    const catsRow = h('div', { class: 'lib-cats' },
      catChip('all', '全部', items.length), ...cats.map((c) => catChip(c.id, c.name, count(c.id))), catChip('', '未分类', count('')),
      h('button', { type: 'button', class: 'chip small dashed', title: '新建分类', onclick: newCat }, icon('plus', 12)));

    const catBar = curCat ? h('div', { class: 'lib-catbar' },
      h('span', { class: 'muted' }, `随机词：生成时从「${curCat.name}」里随机抽一条`),
      h('button', { type: 'button', class: 'btn small ghost', title: `插入 __${curCat.name}__`, onclick: () => insert(`__${curCat.name}__`) }, icon('dice', 14), `插入 __${curCat.name}__`),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => renameCat(curCat) }, '改名'),
      h('button', { type: 'button', class: 'btn small ghost danger', onclick: () => deleteCat(curCat) }, '删除分类')) : null;

    const rows = list.map((x) => {
      const isIn = t && containsAll(t.ta.value, x.text);
      const cn = deps.cnOf(x.text);
      const checked = ui.sel?.has(x.id);
      return h('div', {
        class: `lib-row${isIn ? ' in' : ''}${checked ? ' sel' : ''}`, 'data-id': x.id,
        title: ui.sel ? '' : isIn ? '已在提示词里，点击移除' : `点击插入到「${t?.label}」`,
        onclick: (e) => {
          if (e.target.closest('button')) return;
          if (ui.sel) { checked ? ui.sel.delete(x.id) : ui.sel.add(x.id); return paint(); }
          insert(x.text, isIn);
        },
      },
      ui.sel ? h('input', { type: 'checkbox', checked, tabindex: -1 }) : h('span', { class: 'lib-mark' }, icon(isIn ? 'check' : 'plus', 14)),
      h('div', { class: 'lib-main' },
        x.title ? h('b', {}, x.title) : null,
        h('span', { class: 'lib-text' }, x.text),
        cn ? h('small', {}, cn) : null),
      ui.cat === 'all' && catName(x.cat) ? h('span', { class: 'lib-cat' }, catName(x.cat)) : null,
      ui.sel ? null : h('span', { class: 'lib-acts' },
        h('button', { type: 'button', class: 'icon-btn', title: '编辑', onclick: () => { ui.edit = { ...x }; paint(); } }, icon('edit', 14)),
        h('button', { type: 'button', class: 'icon-btn', title: '删除', onclick: () => lib.mutate((d) => { d.items = d.items.filter((y) => y.id !== x.id); }) }, icon('trash', 14))));
    });

    const batch = ui.sel ? h('div', { class: 'lib-batch' },
      h('span', {}, `已选 ${ui.sel.size}`),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { ui.sel = ui.sel.size === list.length ? new Set() : new Set(list.map((x) => x.id)); paint(); } }, ui.sel.size === list.length && list.length ? '全不选' : '全选'),
      h('button', {
        type: 'button', class: 'btn small ghost', disabled: !ui.sel.size,
        onclick: (e) => deps.openMenu(e.currentTarget, [...cats.map((c) => ({ label: c.name, run: () => moveSel(c.id) })), { label: '未分类', run: () => moveSel('') }]),
      }, '移动到…'),
      h('button', {
        type: 'button', class: 'btn small ghost danger', disabled: !ui.sel.size,
        onclick: async () => {
          const ids = new Set(ui.sel);
          if (!(await deps.confirmDialog(`删除选中的 ${ids.size} 条收藏？`, '删除'))) return;
          ui.sel = new Set();
          lib.mutate((d) => { d.items = d.items.filter((y) => !ids.has(y.id)); });
        },
      }, '删除')) : null;

    const empty = !list.length ? h('div', { class: 'lib-empty' }, items.length ? '没有匹配的收藏' : '还没有收藏。在标签模式下选中词点 ☆，或在 TAG 检索的详情里点「收藏」。') : null;
    return [tools, catsRow, catBar, ui.edit && ui.tab === 'fav' ? favForm() : null, ui.sel ? batch : targetRow(), h('div', { class: 'lib-list' }, empty, ...rows)];
  }

  function insert(text, remove = false) {
    const t = findTarget();
    if (!t) return;
    deps.editPrompt(t.ta, remove ? removeFrom(t.ta.value, text) : addTo(t.ta.value, text));
    toast(remove ? `已从「${t.label}」移除` : `已加到「${t.label}」`);
    paint();
  }

  function moveSel(cat) {
    const ids = new Set(ui.sel);
    ui.sel = new Set();
    lib.mutate((d) => { for (const x of d.items) if (ids.has(x.id)) x.cat = cat; });
  }

  function favForm() {
    const e = ui.edit;
    const text = h('textarea', { class: 'tag-input', rows: 3, spellcheck: 'false', value: e.text, placeholder: '提示词，如 white dress, frills, ribbon' });
    const title = h('input', { type: 'text', value: e.title, placeholder: '备注名（可选）' });
    const cat = h('select', {}, h('option', { value: '' }, '未分类'), ...lib.data.cats.map((c) => h('option', { value: c.id, selected: c.id === e.cat }, c.name)));
    cat.value = e.cat;
    const t = findTarget();
    queueMicrotask(() => text.focus());
    const saveIt = () => {
      const v = text.value.trim();
      if (!v) return toast('提示词不能为空', 'error');
      const item = { id: e.id || uid(), text: v, title: title.value.trim(), cat: cat.value, at: e.at || Date.now() };
      ui.edit = null;
      lib.mutate((d) => {
        const i = d.items.findIndex((x) => x.id === item.id);
        if (i >= 0) d.items[i] = { ...d.items[i], ...item };
        else d.items.unshift(item);
      });
    };
    text.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); saveIt(); } });
    return h('div', { class: 'lib-form' },
      text,
      h('div', { class: 'lib-form-row' }, title, cat,
        t ? h('button', { type: 'button', class: 'btn small ghost', title: `用「${t.label}」的内容填入`, onclick: () => { text.value = t.ta.value; } }, `填入${t.label}`) : null,
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { ui.edit = null; paint(); } }, '取消'),
        h('button', { type: 'button', class: 'btn small primary', onclick: saveIt }, '保存')));
  }

  function newCat() {
    const name = prompt('新分类名称（也是随机词的名字，如 服装 → __服装__）')?.trim();
    if (!name) return;
    if (/[,_]/.test(name)) return onError('分类名不能有逗号或下划线');
    if (lib.data.cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) return onError('已经有这个分类了');
    const c = { id: uid(), name: name.slice(0, 40) };
    if (lib.mutate((d) => { if (!d.cats.some((x) => x.id === c.id)) d.cats.push(c); })) { ui.cat = c.id; paint(); }
  }

  function renameCat(c) {
    const name = prompt('分类改名（提示词里的 __旧名__ 不会自动改）', c.name)?.trim();
    if (!name || name === c.name) return;
    if (/[,_]/.test(name)) return onError('分类名不能有逗号或下划线');
    if (lib.data.cats.some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) return onError('已经有这个分类了');
    lib.mutate((d) => { const x = d.cats.find((y) => y.id === c.id); if (x) x.name = name.slice(0, 40); });
  }

  async function deleteCat(c) {
    const n = lib.data.items.filter((x) => x.cat === c.id).length;
    if (!(await deps.confirmDialog(n ? `删除分类「${c.name}」？里面的 ${n} 条收藏会移到「未分类」。` : `删除分类「${c.name}」？`, '删除'))) return;
    ui.cat = 'all';
    lib.mutate((d) => {
      d.cats = d.cats.filter((x) => x.id !== c.id);
      for (const x of d.items) if (x.cat === c.id) x.cat = '';
    });
  }

  // ---- 导入 / 导出 ----

  function ioMenu(anchor) {
    deps.openMenu(anchor, [
      { label: '导出全部', hint: '收藏、固定词和快照', run: exportAll },
      { label: '导入…', hint: '合并，不会删掉现有的', run: () => fileIn.click() },
    ]);
  }

  function exportAll() {
    const out = { type: 'nai-relay-library', version: 1, exported: new Date().toISOString(), library: lib.data, snapshots: snaps.state === 'ready' ? snaps.data : undefined };
    download(`词库-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2));
  }

  async function importFile(file) {
    let j;
    try {
      j = JSON.parse(await file.text());
    } catch {
      return onError('不是有效的 JSON 文件');
    }
    if (!j || (!j.library && !j.snapshots && !Array.isArray(j.items))) return onError('文件里没有词库内容');
    const src = normLib(j.library || j);
    const srcSnaps = j.snapshots ? normSnaps(j.snapshots) : null;
    let added = 0;
    let addedP = 0;
    let addedS = 0;
    lib.mutate((d) => {
      const catMap = new Map();
      for (const c of src.cats) {
        let x = d.cats.find((y) => y.name.toLowerCase() === c.name.toLowerCase());
        if (!x) d.cats.push((x = { id: c.id && !d.cats.some((y) => y.id === c.id) ? c.id : uid(), name: c.name }));
        catMap.set(c.id, x.id);
      }
      const have = new Set(d.items.map((x) => `${x.cat}|${x.text}`));
      for (const x of src.items) {
        const cat = catMap.get(x.cat) || '';
        if (have.has(`${cat}|${x.text}`)) continue;
        have.add(`${cat}|${x.text}`);
        d.items.push({ ...x, id: d.items.some((y) => y.id === x.id) ? uid() : x.id, cat });
        added++;
      }
      const haveP = new Set(d.presets.map((p) => `${p.name}|${p.pos}|${p.neg}`));
      for (const p of src.presets) {
        if (haveP.has(`${p.name}|${p.pos}|${p.neg}`)) continue;
        d.presets.push({ ...p, id: d.presets.some((y) => y.id === p.id) ? uid() : p.id });
        addedP++;
      }
    });
    if (srcSnaps?.items.length && snaps.state === 'ready') {
      snaps.mutate((d) => {
        const ids = new Set(d.items.map((x) => x.id));
        for (const s of srcSnaps.items) if (!s.auto && !ids.has(s.id) && d.items.filter((x) => !x.auto).length < MAX_SNAPSHOTS) { d.items.push(s); addedS++; }
        d.items.sort((a, b) => b.at - a.at);
      });
    }
    toast(`导入了 ${added} 条收藏、${addedP} 组固定词${srcSnaps ? `、${addedS} 个快照` : ''}`, 'ok', 5000);
  }

  // ---- 固定词 ----

  function presetPane() {
    const list = lib.data.presets;
    const onN = list.filter((p) => p.on).length;
    const head = h('div', { class: 'lib-tools' },
      h('span', { class: 'muted grow' }, `生图时自动加到提示词前面或后面，不会出现在编辑框里。已启用 ${onN} / ${list.length}`),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => { ui.edit = { id: null, name: '', pos: '', neg: '', pin: true, on: true, posEnd: false, negEnd: false }; paint(); } }, icon('plus', 14), '新建'));
    const flip = (id, key) => lib.mutate((d) => { const x = d.presets.find((y) => y.id === id); if (x) x[key] = !x[key]; });
    const line = (p, side) => {
      const neg = side === 'neg';
      const text = neg ? p.neg : p.pos;
      if (!text) return null;
      const key = neg ? 'negEnd' : 'posEnd';
      return h('span', { class: 'lib-text fx-line' },
        h('em', { class: neg ? 'neg' : '' }, neg ? '负面' : '正面'),
        h('button', { type: 'button', class: `fx-pos${p[key] ? ' end' : ''}`, title: '点击切换加在前面还是后面', onclick: () => flip(p.id, key) }, posLabel(p[key])),
        text);
    };
    const rows = list.map((p, i) => h('div', { class: `lib-row preset${p.on ? ' in' : ' off'}`, 'data-id': p.id },
      h('label', { class: 'mini-switch', title: p.on ? '已启用，点击停用' : '已停用，点击启用' },
        h('input', { type: 'checkbox', checked: p.on, onchange: (e) => setPresetOn(p.id, e.target.checked) }), h('i')),
      h('div', { class: 'lib-main' }, h('b', {}, p.name || '未命名'), line(p, 'pos'), line(p, 'neg')),
      h('span', { class: 'lib-acts' },
        h('button', { type: 'button', class: `icon-btn${p.pin ? ' on' : ''}`, title: p.pin ? '取消置顶（停用时不在提示词下方显示）' : '置顶：停用时也显示在提示词下方', onclick: () => flip(p.id, 'pin') }, icon('pin', 14)),
        h('button', { type: 'button', class: 'icon-btn', title: '上移', disabled: !i, onclick: () => lib.mutate((d) => { const k = d.presets.findIndex((y) => y.id === p.id); if (k > 0) d.presets.splice(k - 1, 0, ...d.presets.splice(k, 1)); }) }, icon('up', 14)),
        h('button', { type: 'button', class: 'icon-btn', title: '编辑', onclick: () => { ui.edit = { ...p }; paint(); } }, icon('edit', 14)),
        h('button', { type: 'button', class: 'icon-btn', title: '删除', onclick: () => lib.mutate((d) => { d.presets = d.presets.filter((y) => y.id !== p.id); }) }, icon('trash', 14)))));
    return [head, ui.edit && ui.tab === 'preset' ? presetForm() : null,
      h('div', { class: 'lib-list' }, list.length ? null : h('div', { class: 'lib-empty' }, '还没有固定词。比如把常用的画风串、质量词、负面词存成一组，启用后每次生图自动带上。'), ...rows)];
  }

  function presetForm() {
    const e = ui.edit;
    const name = h('input', { type: 'text', value: e.name, placeholder: '名称，如 厚涂画风', maxlength: 60 });
    const posSel = (end) => h('select', { class: 'mini-select', title: '加在提示词前面还是后面' },
      h('option', { value: '', selected: !end }, '加在前面'), h('option', { value: '1', selected: !!end }, '加在后面'));
    const pos = h('textarea', { class: 'tag-input', rows: 3, spellcheck: 'false', value: e.pos, placeholder: '正面固定词，如 1.3::artist:xxx::, masterpiece' });
    const neg = h('textarea', { class: 'tag-input neg', rows: 2, spellcheck: 'false', value: e.neg, placeholder: '负面固定词（可选）' });
    const posAt = posSel(e.posEnd);
    const negAt = posSel(e.negEnd);
    const on = h('input', { type: 'checkbox', checked: e.on });
    queueMicrotask(() => name.focus());
    const saveIt = () => {
      if (!pos.value.trim() && !neg.value.trim()) return toast('正面和负面至少填一个', 'error');
      const p = {
        id: e.id || uid(), name: name.value.trim() || '未命名', pos: pos.value.trim(), neg: neg.value.trim(), pin: e.pin, at: e.at || Date.now(),
        on: on.checked, posEnd: !!posAt.value, negEnd: !!negAt.value,
      };
      ui.edit = null;
      lib.mutate((d) => {
        const i = d.presets.findIndex((x) => x.id === p.id);
        if (i >= 0) d.presets[i] = p;
        else d.presets.push(p);
      });
    };
    return h('div', { class: 'lib-form' }, name,
      h('div', { class: 'lib-form-row' }, h('span', { class: 'muted' }, '正面'), h('span', { class: 'grow' }), posAt), pos,
      h('div', { class: 'lib-form-row' }, h('span', { class: 'muted' }, '负面'), h('span', { class: 'grow' }), negAt), neg,
      h('div', { class: 'lib-form-row' },
        h('label', { class: 'fx-on' }, on, h('span', {}, '启用')),
        h('button', { type: 'button', class: 'btn small ghost', title: '把编辑框里现在的正面 / 负面提示词复制过来', onclick: () => { pos.value = document.getElementById('prompt').value; neg.value = document.getElementById('negative').value; } }, '用当前提示词填入'),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { ui.edit = null; paint(); } }, '取消'),
        h('button', { type: 'button', class: 'btn small primary', onclick: saveIt }, '保存')));
  }

  // ---- 快照 ----

  function snapPane() {
    const name = h('input', { type: 'text', placeholder: `快照名称（默认 ${fmtTime(Date.now())}）`, maxlength: 80 });
    const doSave = () => {
      if (saveSnapshot(name.value.trim())) toast('已保存快照', 'ok');
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    const head = h('div', { class: 'lib-tools' }, name,
      h('button', { type: 'button', class: 'btn small primary', onclick: doSave }, icon('camera', 14), '保存当前'));
    const rows = snaps.data.items.map((s) => {
      const chars = (s.data.characters || []).filter((c) => c?.prompt?.trim());
      const renaming = ui.renaming === s.id;
      const title = renaming ? h('input', {
        type: 'text', value: s.name, class: 'lib-rename', maxlength: 80,
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ui.renaming = null; paint(); }
        },
        onblur: (e) => {
          if (ui.renaming !== s.id) return;
          ui.renaming = null;
          const v = e.target.value.trim();
          if (v && v !== s.name) snaps.mutate((d) => { const x = d.items.find((y) => y.id === s.id); if (x) { x.name = v; x.auto = false; } });
          else paint();
        },
      }) : h('b', {}, s.name || '未命名');
      if (renaming) queueMicrotask(() => { title.focus(); title.select(); });
      return h('div', { class: `lib-row snap${s.auto ? ' auto' : ''}`, 'data-id': s.id },
        h('div', { class: 'lib-main' },
          h('div', { class: 'snap-head' }, title, s.auto ? h('span', { class: 'lib-cat' }, '自动') : null, h('small', {}, fmtTime(s.at))),
          h('span', { class: 'lib-text' }, s.data.prompt || h('i', { class: 'muted' }, '（正面为空）')),
          chars.length || s.data.negative ? h('small', {}, [chars.length ? `${chars.length} 个角色` : '', s.data.negative ? `负面：${s.data.negative}` : ''].filter(Boolean).join(' · ')) : null),
        h('span', { class: 'lib-acts' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => restoreSnapshot(s) }, '恢复'),
          h('button', { type: 'button', class: 'icon-btn', title: '改名', onclick: () => { ui.renaming = s.id; paint(); } }, icon('edit', 14)),
          h('button', { type: 'button', class: 'icon-btn', title: '删除', onclick: () => snaps.mutate((d) => { d.items = d.items.filter((y) => y.id !== s.id); }) }, icon('trash', 14))));
    });
    return [head, h('div', { class: 'hint' }, '快照保存正面、负面、角色和质量词 / 负面预设设置。恢复前会自动把当前内容存一份。'),
      h('div', { class: 'lib-list' }, rows.length ? null : h('div', { class: 'lib-empty' }, '还没有快照'), ...rows)];
  }

  return {
    load: () => Promise.all([lib.load(), snaps.load()]),
    reset: () => { lib.reset(); snaps.reset(); ui.close?.(); renderBar(); },
    open,
    isOpen: () => !!ui.close,
    quickFavorite,
    pickWild,
    renderBar,
    withFixed: (src) => withFixed(src, presets()),
    stripFixed: (params) => stripFixed(params, presets()),
    saveSnapshot,
    hasCategory: (name) => lib.data.cats.some((c) => c.name.toLowerCase() === name.toLowerCase()),
    agent: agentApi(),
  };

  /** 给生图助手用的读写接口：出错直接抛异常，由助手转告给大模型 */
  function agentApi() {
    const need = (doc, what) => {
      if (doc.state === 'idle' || doc.state === 'error') doc.load();
      if (doc.state !== 'ready') throw new Error(`${what}还没从服务器载入，稍后再试`);
    };
    const hit = (q, ...texts) => !q || texts.some((t) => (t || '').toLowerCase().includes(q));
    return {
      /** 当前启用的固定词（生图时自动拼到提示词前后，不在 prompt 里） */
      fixed: () => presets().filter((p) => p.on).map((p) => ({
        name: p.name, positive: p.pos || undefined, positive_position: p.pos ? (p.posEnd ? 'suffix' : 'prefix') : undefined,
        negative: p.neg || undefined, negative_position: p.neg ? (p.negEnd ? 'suffix' : 'prefix') : undefined,
      })),
      search(query = '', limit = 30) {
        need(lib, '词库');
        const q = String(query).trim().toLowerCase();
        const d = lib.data;
        return {
          categories: d.cats.map((c) => ({ name: c.name, count: d.items.filter((x) => x.cat === c.id).length, wildcard: `__${c.name}__` })),
          favorites: d.items.filter((x) => hit(q, x.text, x.title, catName(x.cat))).slice(0, limit)
            .map((x) => ({ text: x.text, title: x.title || undefined, category: catName(x.cat) || '未分类' })),
          presets: d.presets.filter((p) => hit(q, p.name, p.pos, p.neg)).slice(0, limit)
            .map((p) => ({ name: p.name, positive: p.pos, negative: p.neg, enabled: p.on, positive_position: p.posEnd ? 'suffix' : 'prefix', negative_position: p.negEnd ? 'suffix' : 'prefix', pinned: p.pin })),
        };
      },
      favorite(text, category = '') {
        need(lib, '词库');
        text = String(text || '').trim();
        if (!text) throw new Error('要收藏的内容是空的');
        let cat = '';
        if (category && category !== '未分类') {
          const c = lib.data.cats.find((x) => x.name.toLowerCase() === String(category).trim().toLowerCase());
          if (!c) throw new Error(`没有「${category}」这个分类，现有分类：${lib.data.cats.map((x) => x.name).join('、') || '无'}`);
          cat = c.id;
        }
        const key = splitPrompt(text).map(segKey).join(',');
        if (lib.data.items.some((x) => x.cat === cat && splitPrompt(x.text).map(segKey).join(',') === key)) return { saved: false, reason: '这个分类里已经有了' };
        const item = { id: uid(), text, title: '', cat, at: Date.now() };
        if (!lib.mutate((d) => { if (!d.items.some((x) => x.id === item.id)) d.items.unshift(item); })) throw new Error('词库保存失败');
        return { saved: true, category: catName(cat) || '未分类' };
      },
      snapshots(limit = 30) {
        need(snaps, '快照');
        return snaps.data.items.slice(0, limit).map((s) => ({
          id: s.id, name: s.name, auto: s.auto || undefined, saved_at: new Date(s.at).toISOString(),
          prompt: (s.data.prompt || '').slice(0, 300), characters: (s.data.characters || []).length,
        }));
      },
      saveSnapshot(name) {
        need(snaps, '快照');
        if (!saveSnapshot(String(name || '').slice(0, 80) || '助手保存', false)) throw new Error('快照没能保存');
        return { saved: true };
      },
      restoreSnapshot(id) {
        need(snaps, '快照');
        const s = snaps.data.items.find((x) => x.id === id);
        if (!s) throw new Error('没有这个快照，先用 list_snapshots 看看');
        restoreSnapshot(s);
        return { restored: s.name };
      },
    };
  }
}
