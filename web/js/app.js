import * as N from './nai.js';
import { createTagPanel, CJK, toPrompt, fmtCount } from './tags.js';
import { createTagBoard, resolvePrompt, history, resetHistories } from './prompt.js';
import { createLibrary } from './library.js';
import {
  $, h, icon, blobToB64, bytesToB64, hashString, padForReference, fitDims, resizeToPng, makeThumb,
  quantizeMask, unzip, isImageBytes, readPngText, readStealthMeta, zipFiles, store, safeStorage, uid, randomSeed, clamp,
  debounce,
} from './util.js';

const KEY_STORAGE = 'nai-studio:key';
const STATE_STORAGE = 'nai-studio:state';
// 只持久化文字和数值参数；参考图、底图体积大，只留在内存里
const PERSIST = [
  'modelId', 'prompt', 'negative', 'ucPreset', 'quality', 'characters', 'autoPosition', 'width', 'height', 'steps',
  'scale', 'sampler', 'noiseSchedule', 'cfgRescale', 'seed', 'nSamples', 'variety', 'transparent', 'refTab',
];
const PARAM_KEYS = PERSIST.filter((k) => k !== 'refTab');
const BASE_MAX_AREA = 1536 * 1024;
const MAX_VIBES = 10;

const defaults = () => ({
  modelId: 'nai-diffusion-4-5-full',
  prompt: '',
  negative: '',
  ucPreset: 'heavy',
  quality: true,
  characters: [],
  autoPosition: true,
  width: 832,
  height: 1216,
  steps: 23,
  scale: 5,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  cfgRescale: 0,
  seed: '',
  nSamples: 1,
  variety: false,
  transparent: false,
  refTab: 'charRef',
  base: null,
  charRefs: [],
  vibes: [],
});

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, obj[k]]));

// 设置按用户分开保存，登录后再读取（见 loadUserState）
const S = defaults();

const app = {
  key: safeStorage(KEY_STORAGE) || '',
  sub: null,
  queue: null,
  busy: null,
  busyLabel: '',
  view: null,
  viewUrl: null,
  history: [],
  thumbUrls: new Map(),
  pollTimer: null,
  user: null, // { id, name, admin }
  select: null, // 历史多选模式下选中的 id
  lastPick: -1,
};

const stateKey = () => `${STATE_STORAGE}:${app.user.id}`;
const persist = () => app.user && safeStorage(stateKey(), pick(S, PERSIST));
const save = debounce(persist, 300);
const model = () => N.modelById(S.modelId);
const caps = () => N.capsOf(model());
const cur = () => (app.view ? app.view.items[app.view.index] : null);
const api = N.createApi(() => app.key, () => logout('密钥已失效，请重新输入'));
// TAG 检索面板、词库可以往这些输入框里加词：正面、负面、各个角色
let lastTagTarget = 'prompt';
const promptTargets = () => [
  { id: 'prompt', label: '正面', ta: $('#prompt') },
  { id: 'negative', label: '负面', ta: $('#negative') },
  ...S.characters.map((ch, i) => ({ id: `char:${ch.id}`, label: `角色 ${i + 1}`, ta: document.querySelector(`textarea[data-char="${ch.id}"]`) })),
].filter((t) => t.ta);
const tagPanel = createTagPanel({
  api,
  toast: (...a) => toast(...a),
  beforeEdit: () => { sug.skip = true; },
  targets: promptTargets,
  initialTarget: () => lastTagTarget,
  favorite: (text, anchor) => library.quickFavorite(text, anchor),
});
const library = createLibrary({
  api,
  getKey: () => app.key,
  toast: (...a) => toast(...a),
  openModal: (...a) => openModal(...a),
  confirmDialog: (...a) => confirmDialog(...a),
  openMenu: (...a) => openMenu(...a),
  targets: promptTargets,
  initialTarget: () => lastTagTarget,
  editPrompt: (ta, v) => editPrompt(ta, v),
  cnOf: (t) => tagPanel.cnOf(t),
  getPromptState: () => structuredClone(pick(S, SNAPSHOT_KEYS)),
  applyPromptState: (d) => applyPromptState(d),
});
const SNAPSHOT_KEYS = ['prompt', 'negative', 'characters', 'quality', 'ucPreset', 'autoPosition'];

/** 程序改提示词输入框：记进撤销栈，然后触发 input 让设置和标签视图跟着更新 */
function editPrompt(ta, value) {
  if (ta.value === value) return;
  const hs = history(ta.dataset.hist || ta.id);
  hs.undo.push(ta.value);
  if (hs.undo.length > 100) hs.undo.shift();
  hs.redo.length = 0;
  setPrompt(ta, value);
}

function setPrompt(ta, value) {
  ta.value = value;
  sug.skip = true;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  sug.skip = false;
}

function applyPromptState(d) {
  editPrompt($('#prompt'), d.prompt ?? '');
  editPrompt($('#negative'), d.negative ?? '');
  for (const k of ['quality', 'ucPreset', 'autoPosition']) if (d[k] !== undefined) S[k] = d[k];
  S.characters = (Array.isArray(d.characters) ? d.characters : []).map((c) => ({ enabled: true, prompt: '', negative: '', x: 0.5, y: 0.5, ...c, id: uid() }));
  syncControls();
  renderCharacters();
  changed('quality');
}

// ---------- 标签模式 ----------

const TAGMODE_STORAGE = 'nai-studio:tagmode';
const boards = new Set();

function mountBoard(ta) {
  const b = createTagBoard(ta, {
    edit: setPrompt,
    cnOf: (t) => tagPanel.cnOf(t),
    isKnown: (t) => tagPanel.known(t),
    translate: (names) => tagPanel.translate(names),
    attachSuggest,
    favorite: (text, anchor) => library.quickFavorite(text, anchor),
    lookup: (text) => {
      const id = ta.dataset.char ? `char:${ta.dataset.char}` : ta.id;
      if (promptTargets().some((t) => t.id === id)) lastTagTarget = id;
      tagPanel.open(text);
    },
  });
  boards.add(b);
  if (document.body.classList.contains('tagmode')) b.render();
  return b;
}

function refreshBoards() {
  if (!document.body.classList.contains('tagmode')) return;
  for (const b of [...boards]) {
    if (!b.el.isConnected) boards.delete(b);
    else b.render();
  }
}

function setTagMode(on) {
  document.body.classList.toggle('tagmode', on);
  safeStorage(TAGMODE_STORAGE, on ? 1 : null);
  for (const b of $('#mode-toggle').children) b.classList.toggle('on', (b.dataset.mode === 'tag') === on);
  closeSuggest();
  refreshBoards();
}

// ---------- 通用 UI ----------

function toast(msg, type = 'info', ms = 3600) {
  const el = h('div', { class: `toast ${type}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function openModal({ title, body, foot, wide = false, cls = '', onClose }) {
  const overlay = h('div', { class: 'overlay' });
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  overlay.append(
    h('div', { class: `modal${wide ? ' wide' : ''}${cls ? ` ${cls}` : ''}` },
      h('div', { class: 'modal-head' }, h('span', {}, title), h('button', { class: 'icon-btn', type: 'button', onclick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      foot ? h('div', { class: 'modal-foot' }, foot) : null),
  );
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  return close;
}

function confirmDialog(message, okLabel = '确定') {
  return new Promise((resolve) => {
    let ok = false;
    const close = openModal({
      title: '确认',
      body: h('p', { class: 'muted', style: { margin: 0 } }, message),
      foot: [
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, '取消'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { ok = true; close(); } }, okLabel),
      ],
      onClose: () => resolve(ok),
    });
  });
}

function slider({ min, max, step, get, set }) {
  const decimals = (String(step).split('.')[1] || '').length;
  const range = h('input', { type: 'range', min, max, step });
  const num = h('input', { type: 'number', min, max, step });
  const paint = (v) => {
    range.value = v;
    num.value = (+v).toFixed(decimals);
    range.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  };
  range.addEventListener('input', () => {
    const v = +(+range.value).toFixed(decimals);
    set(v);
    paint(v);
  });
  num.addEventListener('change', () => {
    const v = +clamp(+num.value || 0, min, max).toFixed(decimals);
    set(v);
    paint(v);
  });
  const el = h('div', { class: 'slider' }, range, num);
  el.sync = () => paint(get());
  el.sync();
  return el;
}

const field = (label, control) => h('div', { class: 'field' }, h('label', {}, label), control);

function seg(options, value, onPick, cls = '') {
  const el = h('div', { class: `seg ${cls}` });
  for (const [v, label] of options) {
    el.append(h('button', {
      type: 'button',
      class: v === value ? 'on' : '',
      onclick: (e) => {
        for (const b of el.children) b.classList.toggle('on', b === e.currentTarget);
        onPick(v);
      },
    }, label));
  }
  return el;
}

function pickImages(multiple = false) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', multiple });
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

let dragDepth = 0;
function resetDrop() {
  dragDepth = 0;
  $('#drop-hint').hidden = true;
}

// 拖放来源可能是文件，也可能是右侧的历史图片
async function blobsFromDrop(e) {
  const id = e.dataTransfer.getData('text/x-nai-id');
  if (id) {
    const rec = app.history.find((r) => r.id === id);
    return rec ? [rec.blob] : [];
  }
  return [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
}

function dropzone(label, sub, onFiles, multiple = false) {
  const dz = h('div', { class: 'dropzone', onclick: async () => onFiles(await pickImages(multiple)) },
    icon('upload', 20), h('div', {}, label), sub ? h('small', {}, sub) : null);
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dz.classList.remove('over');
    resetDrop();
    const blobs = await blobsFromDrop(e);
    if (blobs.length) onFiles(multiple ? blobs : blobs.slice(0, 1));
  });
  return dz;
}

function removeBtn(onclick) {
  return h('button', { class: 'icon-btn', type: 'button', title: '移除', onclick }, icon('trash', 14));
}

// ---------- 控件绑定 ----------

const sliders = [];

function buildStatic() {
  $('#uc-preset').append(...N.UC_PRESETS.map((p) => h('option', { value: p.id }, p.label)));
  $('#sampler').append(...N.SAMPLERS.map(([v, l]) => h('option', { value: v }, l)));
  $('#noise-schedule').append(...N.NOISE_SCHEDULES.map((v) => h('option', { value: v }, v)));
  $('#logout').append(icon('logout'));
  $('#seed-dice').append(icon('dice'));
  $('#seed-clear').append(icon('x', 14));
  $('#hist-clear').append(icon('trash', 15));
  $('#hist-select').append(icon('check', 15));

  for (const ph of document.querySelectorAll('[data-slider]')) {
    const key = ph.dataset.slider;
    const s = slider({
      min: +ph.dataset.min, max: +ph.dataset.max, step: +ph.dataset.step,
      get: () => S[key],
      set: (v) => { S[key] = v; changed(key); },
    });
    ph.replaceWith(s);
    sliders.push(s);
  }

  const tools = [
    ['download', '下载', downloadCurrent],
    ['copy', '复制', copyCurrent],
    'sep',
    ['image', '设为底图', () => setBase(cur().blob)],
    ['brush', '局部重绘', () => setBase(cur().blob, true)],
    ['upscale', '放大', upscaleCurrent],
    ['wand', '导演工具', (e) => openDirectorMenu(e.currentTarget)],
    'sep',
    ['reuse', '复用参数', reuseCurrent, true],
    ['hash', '用此种子', useSeedCurrent, true],
  ];
  for (const t of tools) {
    if (t === 'sep') {
      $('#tools').append(h('span', { class: 'sep' }));
      continue;
    }
    const [ic, label, fn, needParams] = t;
    const b = h('button', { class: 'btn', type: 'button', title: label, onclick: (e) => cur() && fn(e) }, icon(ic, 15), h('span', {}, label));
    if (needParams) b.dataset.needParams = '1';
    if (ic === 'upscale' || ic === 'wand') {
      b.dataset.cost = ic;
      b.append(h('small', { class: 'tool-cost' }));
    }
    $('#tools').append(b);
  }
}

function bindControls() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (key === 'seed') {
        v = v.replace(/\D/g, '').slice(0, 10);
        if (v && +v > 4294967295) v = '4294967295';
        el.value = v;
      }
      if ('num' in el.dataset) {
        v = parseInt(v, 10);
        if (!Number.isFinite(v)) return;
      }
      S[key] = v;
      changed(key);
    });
  }
  for (const k of ['width', 'height']) {
    $(`[data-key=${k}]`).addEventListener('change', (e) => {
      S[k] = clamp(Math.round((+e.target.value || 64) / 64) * 64, 64, 3072);
      e.target.value = S[k];
      changed(k);
    });
  }
  for (const ta of document.querySelectorAll('.controls textarea.tag-input')) {
    attachSuggest(ta);
    mountBoard(ta);
  }
  $('#tag-open').append(icon('tag', 13), h('span', {}, 'TAG 检索'));
  $('#tag-open').addEventListener('click', () => tagPanel.toggleOpen());
  $('#lib-open').append(icon('book', 13), h('span', {}, '词库'));
  $('#lib-open').addEventListener('click', () => library.open('fav'));
  $('#snap-open').append(icon('camera', 13), h('span', {}, '快照'));
  $('#snap-open').addEventListener('click', () => library.open('snap'));
  for (const b of $('#mode-toggle').children) b.addEventListener('click', () => setTagMode(b.dataset.mode === 'tag'));
  setTagMode(!!safeStorage(TAGMODE_STORAGE));
  $('#prompt').addEventListener('input', () => library.renderBar());
  $('#negative').addEventListener('input', () => library.renderBar());
  // 记住最后编辑的是哪个输入框，打开 TAG 面板、词库时默认加到那里
  document.addEventListener('focusin', (e) => {
    const ta = e.target.matches?.('.controls .tb-add, .controls .tb') ? e.target.closest('.tb').ta : e.target;
    if (!ta.matches?.('.controls textarea.tag-input')) return;
    lastTagTarget = ta.dataset.char ? `char:${ta.dataset.char}` : ta.id || lastTagTarget;
  });
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k' && app.key) {
      e.preventDefault();
      const ta = document.activeElement;
      const tok = ta?.matches?.('textarea.tag-input, .tb-add') ? tokenAt(ta) : null;
      tagPanel.open(tok?.word);
    }
  });

  $('#swap-size').addEventListener('click', () => {
    [S.width, S.height] = [S.height, S.width];
    syncControls();
    changed('width');
  });
  $('#seed-dice').addEventListener('click', () => { S.seed = String(randomSeed()); syncControls(); save(); });
  $('#seed-clear').addEventListener('click', () => { S.seed = ''; syncControls(); save(); });
  $('#add-char').addEventListener('click', () => {
    S.characters.push({ id: uid(), enabled: true, prompt: '', negative: '', x: 0.5, y: 0.5 });
    renderCharacters();
    save();
    $('#chars').lastElementChild?.querySelector('textarea')?.focus();
  });
  for (const b of $('#ref-tabs').children) {
    b.addEventListener('click', () => { S.refTab = b.dataset.tab; renderTabs(); save(); });
  }
  $('#generate').addEventListener('click', generate);
  $('#busy-cancel').addEventListener('click', () => app.busy?.abort());
  $('#logout').addEventListener('click', () => logout());
  $('#hist-clear').addEventListener('click', clearHistory);
  $('#hist-select').addEventListener('click', () => setSelecting(!app.select));
  $('#view-img').addEventListener('click', () => $('#viewer').classList.toggle('zoom'));
  $('#login-form').addEventListener('submit', onLogin);
}

function syncControls() {
  for (const el of document.querySelectorAll('[data-key]')) {
    const v = S[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v ?? '';
  }
  for (const s of sliders) s.sync();
  refreshBoards();
  library.renderBar();
}

function changed(key) {
  save();
  if (key === 'width' || key === 'height') renderSizes();
  if (key === 'autoPosition') renderCharacters();
  if (key === 'nSamples') renderNSamples();
  updateCost();
}

function renderAll() {
  renderModels();
  for (const el of document.querySelectorAll('[data-cap]')) el.hidden = !caps()[el.dataset.cap];
  syncControls();
  renderSizes();
  renderNSamples();
  renderCharacters();
  renderTabs();
  renderCharRefs();
  renderVibes();
  renderBase();
  updateBadges();
  updateCost();
}

// ---------- 模型 / 尺寸 / 张数 ----------

function renderModels() {
  $('#models').replaceChildren(...N.MODELS.map((m) => h('button', {
    type: 'button',
    class: m.id === S.modelId ? 'on' : '',
    onclick: () => m.id !== S.modelId && switchModel(m.id),
  }, h('b', {}, m.label), h('small', {}, m.sub))));
  $('#model-hint').textContent = model().v5
    ? 'V5：透明背景、引号内文字自动生成、最多 32 个角色；暂不支持角色参考和氛围迁移。'
    : 'V4.5：支持角色参考、氛围迁移、Variety+；Opus 会员 1MP 以内单张免费。';
}

function switchModel(id) {
  const prev = model();
  S.modelId = id;
  const next = model();
  if (prev.v5 !== next.v5) {
    // 参数还是旧模型默认值时，顺手换成新模型的默认值
    const pd = N.DEFAULTS[prev.v5 ? 'v5' : 'v45'];
    const nd = N.DEFAULTS[next.v5 ? 'v5' : 'v45'];
    if (S.scale === pd.scale) S.scale = nd.scale;
    if (S.steps === pd.steps) S.steps = nd.steps;
  }
  for (const v of S.vibes) v.cached = null;
  checkVibeCache();
  renderAll();
  save();
}

function renderSizes() {
  const locked = !!S.base;
  const max = Math.max(...N.SIZES.map((s) => Math.max(s.w, s.h)));
  $('#sizes').replaceChildren(...N.SIZES.map((s) => h('button', {
    type: 'button',
    class: `chip${s.w === S.width && s.h === S.height ? ' on' : ''}`,
    disabled: locked,
    onclick: () => { S.width = s.w; S.height = s.h; syncControls(); changed('width'); },
  }, h('span', { class: 'ar', style: { width: `${(12 * s.w) / max}px`, height: `${(12 * s.h) / max}px` } }), s.label, h('small', {}, `${s.w}×${s.h}`))));
  for (const el of document.querySelectorAll('.size-row input, #swap-size')) el.disabled = locked;
  $('#size-lock').hidden = !locked;

  const px = S.width * S.height;
  const hint = $('#pixel-hint');
  hint.className = 'hint inline';
  if (S.width % 64 || S.height % 64) {
    hint.textContent = '宽高需为 64 的倍数';
    hint.classList.add('bad');
  } else if (px > N.MAX_PIXELS) {
    hint.textContent = `${(px / 1e6).toFixed(2)} MP · 超过上限`;
    hint.classList.add('bad');
  } else {
    hint.textContent = `${(px / 1e6).toFixed(2)} MP`;
    if (px > N.FREE_PIXELS) {
      hint.classList.add('warn');
      hint.title = '超过 1024×1024，Opus 也会消耗 Anlas';
    } else hint.title = '';
  }
}

function renderNSamples() {
  const el = seg([1, 2, 3, 4].map((n) => [n, n]), S.nSamples, (n) => { S.nSamples = n; changed('nSamples'); }, 'small');
  el.id = 'nsamples';
  $('#nsamples').replaceWith(el);
}

// ---------- 角色 ----------

function renderCharacters() {
  const c = caps();
  $('#chars').replaceChildren(...S.characters.map(charCard));
  tagPanel.refreshTargets();
  const n = S.characters.length;
  const count = $('#char-count');
  count.textContent = n ? `${n}/${c.maxCharacters}` : '';
  count.style.color = n > c.maxCharacters ? 'var(--warn)' : '';
  count.title = n > c.maxCharacters ? `当前模型最多 ${c.maxCharacters} 个角色，多出的不会生效` : '';
  const add = $('#add-char');
  add.disabled = n >= c.maxCharacters;
  add.replaceChildren(icon('plus', 14), document.createTextNode(add.disabled ? `最多 ${c.maxCharacters} 个角色` : '添加角色'));
}

function charCard(ch, i) {
  const prompt = h('textarea', {
    class: 'tag-input', rows: 2, spellcheck: 'false', value: ch.prompt, 'data-char': ch.id, 'data-hist': `c:${ch.id}:p`,
    placeholder: '角色提示词，如 girl, red hair, school uniform',
    oninput: (e) => { ch.prompt = e.target.value; save(); },
  });
  const neg = h('textarea', {
    class: 'tag-input neg', rows: 1, spellcheck: 'false', value: ch.negative, 'data-hist': `c:${ch.id}:n`,
    placeholder: '这个角色不要出现的（可选）',
    oninput: (e) => { ch.negative = e.target.value; save(); },
  });
  attachSuggest(prompt);
  attachSuggest(neg);

  const grid = h('div', { class: 'pos-grid', title: '角色在画面中的大致位置', hidden: S.autoPosition });
  for (let k = 0; k < 25; k++) {
    const x = +(0.1 + 0.2 * (k % 5)).toFixed(1);
    const y = +(0.1 + 0.2 * Math.floor(k / 5)).toFixed(1);
    grid.append(h('button', {
      type: 'button',
      class: Math.abs(ch.x - x) < 0.01 && Math.abs(ch.y - y) < 0.01 ? 'on' : '',
      onclick: (e) => {
        ch.x = x;
        ch.y = y;
        for (const b of grid.children) b.classList.toggle('on', b === e.currentTarget);
        save();
      },
    }));
  }

  const card = h('div', { class: `char-card${ch.enabled ? '' : ' off'}` });
  const toggle = h('input', {
    type: 'checkbox', class: 'switch', checked: ch.enabled, title: '启用 / 停用',
    onchange: (e) => { ch.enabled = e.target.checked; card.classList.toggle('off', !ch.enabled); save(); },
  });
  const n = S.characters.length;
  const move = (to) => {
    S.characters.splice(to, 0, ...S.characters.splice(i, 1));
    renderCharacters();
    save();
  };
  const mini = (ic, title, onclick, disabled = false) => h('button', { class: 'icon-btn', type: 'button', title, onclick, disabled }, icon(ic, 14));
  const texts = h('div', { class: 'char-texts' }, prompt, neg);
  card.append(
    h('div', { class: 'char-head' },
      h('span', { class: 'idx' }, i + 1),
      h('span', { class: 'name' }, `角色 ${i + 1}`),
      h('span', { class: 'char-tools' },
        mini('star', '收藏这个角色的提示词', (e) => (ch.prompt.trim() ? library.quickFavorite(ch.prompt, e.currentTarget) : toast('先写角色提示词', 'error'))),
        mini('up', '上移', () => move(i - 1), i === 0),
        mini('down', '下移', () => move(i + 1), i === n - 1),
        mini('copy', '复制一份', () => {
          if (n >= caps().maxCharacters) return toast(`当前模型最多 ${caps().maxCharacters} 个角色`, 'error');
          S.characters.splice(i + 1, 0, { ...structuredClone(ch), id: uid() });
          renderCharacters();
          save();
        })),
      toggle,
      removeBtn(() => { S.characters.splice(i, 1); renderCharacters(); save(); })),
    h('div', { class: 'char-body' }, texts, grid),
  );
  mountBoard(prompt);
  mountBoard(neg);
  return card;
}

// ---------- 参考图 ----------

function renderTabs() {
  const c = caps();
  for (const b of $('#ref-tabs').children) {
    b.classList.toggle('on', b.dataset.tab === S.refTab);
    b.classList.toggle('na', (b.dataset.tab === 'charRef' && !c.charRef) || (b.dataset.tab === 'vibe' && !c.vibe));
  }
  for (const p of document.querySelectorAll('.tab-pane')) p.hidden = p.dataset.pane !== S.refTab;
}

function updateBadges() {
  const [a, b, c] = $('#ref-tabs').querySelectorAll('.badge');
  a.textContent = S.charRefs.length || '';
  b.textContent = S.vibes.length || '';
  c.textContent = S.base ? (S.base.mask ? '重绘' : '图') : '';
}

function refsChanged() {
  renderCharRefs();
  renderVibes();
  updateBadges();
  updateCost();
}

function renderCharRefs() {
  const c = caps();
  const items = [];
  if (!c.charRef) items.push(h('div', { class: 'notice' }, '当前模型不支持角色参考，切换到 V4.5 后生效。'));
  for (const r of S.charRefs) items.push(charRefCard(r));
  if (!S.charRefs.length) {
    items.push(dropzone('上传角色参考图', '保持角色外观或画风 · 每张图额外 5 Anlas', addCharRef));
  } else {
    items.push(h('div', { class: 'hint' }, '强度越高越像参考图；保真度越高细节越贴近。每生成一张额外消耗 5 Anlas（Opus 也收费）。'));
  }
  if (S.charRefs.length && S.vibes.length && c.charRef) {
    items.push(h('div', { class: 'notice' }, '同时设置了氛围迁移：两者不能同时使用，生成时只用角色参考。'));
  }
  $('#pane-charRef').replaceChildren(...items);
}

async function addCharRef(files) {
  if (!files[0]) return;
  try {
    const b64 = await padForReference(files[0]);
    S.charRefs = [{ id: uid(), b64, url: URL.createObjectURL(files[0]), type: 'character&style', strength: 1, fidelity: 0.8 }];
  } catch (e) {
    toast(`图片读取失败：${e.message}`, 'error');
  }
  refsChanged();
}

function charRefCard(r) {
  return h('div', { class: 'ref-card' },
    h('img', { class: 'ref-thumb', src: r.url, alt: '' }),
    h('div', { class: 'ref-body' },
      h('div', { class: 'ref-top' },
        seg(N.REF_TYPES, r.type, (v) => { r.type = v; }),
        removeBtn(() => {
          URL.revokeObjectURL(r.url);
          S.charRefs = S.charRefs.filter((x) => x !== r);
          refsChanged();
        })),
      field('强度', slider({ min: 0, max: 1, step: 0.01, get: () => r.strength, set: (v) => { r.strength = v; } })),
      field('保真度', slider({ min: 0, max: 1, step: 0.01, get: () => r.fidelity, set: (v) => { r.fidelity = v; } }))));
}

const vibeKey = (v) => `${(v.hash ||= hashString(v.b64))}:${v.info.toFixed(2)}:${model().id}`;

const checkVibeCache = debounce(async () => {
  for (const v of S.vibes) {
    try {
      v.cached = !!(await store.getVibe(vibeKey(v)));
    } catch {
      v.cached = false;
    }
    paintVibeStatus(v);
  }
  updateCost();
}, 250);

function paintVibeStatus(v) {
  if (!v.statusEl) return;
  v.statusEl.textContent = v.cached ? '✓ 已编码，可直接用' : v.cached === false ? '首次使用需编码 · 2 Anlas' : '…';
  v.statusEl.className = `ref-status${v.cached ? ' ok' : ''}`;
}

function renderVibes() {
  const c = caps();
  const items = [];
  if (!c.vibe) items.push(h('div', { class: 'notice' }, '当前模型不支持氛围迁移，切换到 V4.5 后生效。'));
  for (const v of S.vibes) items.push(vibeCard(v));
  if (S.vibes.length < MAX_VIBES) {
    items.push(dropzone(S.vibes.length ? '继续添加' : '上传氛围参考图', '借用参考图的画风、色调、氛围 · 可多选', addVibes, true));
  }
  items.push(h('div', { class: 'hint' }, '信息量越低越只取整体风格。每张图首次使用要编码（2 Anlas，结果会缓存在本浏览器）；超过 4 张后每张每次 +2 Anlas。'));
  $('#pane-vibe').replaceChildren(...items);
}

async function addVibes(files) {
  for (const f of files.slice(0, MAX_VIBES - S.vibes.length)) {
    try {
      S.vibes.push({ id: uid(), b64: await padForReference(f), url: URL.createObjectURL(f), strength: 0.6, info: 1, cached: null });
    } catch (e) {
      toast(`图片读取失败：${e.message}`, 'error');
    }
  }
  refsChanged();
  checkVibeCache();
}

function vibeCard(v) {
  v.statusEl = h('span', { class: 'ref-status' });
  paintVibeStatus(v);
  return h('div', { class: 'ref-card' },
    h('img', { class: 'ref-thumb', src: v.url, alt: '' }),
    h('div', { class: 'ref-body' },
      h('div', { class: 'ref-top' },
        v.statusEl,
        removeBtn(() => {
          URL.revokeObjectURL(v.url);
          S.vibes = S.vibes.filter((x) => x !== v);
          refsChanged();
        })),
      field('强度', slider({ min: 0, max: 1, step: 0.01, get: () => v.strength, set: (x) => { v.strength = x; } })),
      field('信息量', slider({
        min: 0.01, max: 1, step: 0.01, get: () => v.info,
        set: (x) => { v.info = x; v.cached = null; paintVibeStatus(v); checkVibeCache(); },
      }))));
}

async function encodeVibes(signal) {
  const out = [];
  for (const [i, v] of S.vibes.entries()) {
    const key = vibeKey(v);
    let enc = await store.getVibe(key).catch(() => null);
    if (!enc) {
      setBusyText(`编码氛围参考 ${i + 1}/${S.vibes.length}`);
      enc = bytesToB64(await api.encodeVibe({ image: v.b64, model: model().id, information_extracted: v.info }, signal));
      store.putVibe(key, enc).catch(() => {});
      v.cached = true;
      paintVibeStatus(v);
    }
    out.push({ encoded: enc, strength: v.strength, info: v.info });
  }
  return out;
}

// ---------- 底图 / 蒙版 ----------

function renderBase() {
  const pane = $('#pane-base');
  const b = S.base;
  if (!b) {
    pane.replaceChildren(
      dropzone('上传底图', '图生图，或画蒙版做局部重绘', (f) => f[0] && setBase(f[0])),
      h('div', { class: 'hint' }, '也可以在生成结果下方点「设为底图」或「局部重绘」，或者直接把历史图片拖进来。'),
    );
    return;
  }
  const overlay = b.maskUrl
    ? h('div', { class: 'mask-overlay', style: { webkitMaskImage: `url(${b.maskUrl})`, maskImage: `url(${b.maskUrl})` } })
    : null;
  pane.replaceChildren(h('div', { class: 'base-card' },
    h('div', { class: 'base-preview' },
      h('div', { class: 'base-img' }, h('img', { src: b.url, alt: '' }), overlay),
      h('span', { class: 'base-tag' }, b.mask ? '局部重绘' : '图生图')),
    field('强度', slider({ min: 0.01, max: 0.99, step: 0.01, get: () => b.strength, set: (v) => { b.strength = v; updateCost(); } })),
    b.mask ? null : field('噪声', slider({ min: 0, max: 0.99, step: 0.01, get: () => b.noise, set: (v) => { b.noise = v; } })),
    h('div', { class: 'base-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: openMaskEditor }, icon('brush', 14), b.mask ? '编辑蒙版' : '画蒙版重绘'),
      b.mask ? h('button', { class: 'btn small', type: 'button', onclick: clearMask }, icon('eraser', 14), '清除蒙版') : null,
      h('button', { class: 'btn small danger', type: 'button', onclick: () => clearBase() }, icon('trash', 14), '移除')),
    h('div', { class: 'hint' }, `尺寸跟随底图：${b.width}×${b.height}。强度越高改动越大${b.mask ? '，只重绘蒙版区域' : ''}。`)));
}

function baseChanged() {
  renderBase();
  renderSizes();
  updateBadges();
  updateCost();
}

async function setBase(blob, withMask = false) {
  try {
    const bmp = await createImageBitmap(blob);
    const [w0, h0] = [bmp.width, bmp.height];
    bmp.close();
    let [w, hh] = [w0, h0];
    if (w % 64 || hh % 64 || w * hh > BASE_MAX_AREA) [w, hh] = fitDims(w0, h0, Math.min(w0 * h0, BASE_MAX_AREA));
    const { blob: png, b64 } = await resizeToPng(blob, w, hh);
    clearBase(false);
    S.base = { b64, url: URL.createObjectURL(png), width: w, height: hh, strength: 0.7, noise: 0, mask: null, maskUrl: null, maskCanvas: null };
    S.width = w;
    S.height = hh;
    S.refTab = 'base';
    syncControls();
    renderTabs();
    baseChanged();
    save();
    if (withMask) openMaskEditor();
    else toast(`已设为底图（${w}×${hh}）`, 'ok');
  } catch (e) {
    toast(`图片读取失败：${e.message}`, 'error');
  }
}

function clearMask() {
  const b = S.base;
  if (b.maskUrl) URL.revokeObjectURL(b.maskUrl);
  Object.assign(b, { mask: null, maskUrl: null, maskCanvas: null });
  baseChanged();
}

function clearBase(rerender = true) {
  if (!S.base) return;
  URL.revokeObjectURL(S.base.url);
  if (S.base.maskUrl) URL.revokeObjectURL(S.base.maskUrl);
  S.base = null;
  if (rerender) baseChanged();
}

function openMaskEditor() {
  const b = S.base;
  if (!b) return;
  const canvas = h('canvas', { width: b.width, height: b.height });
  const ctx = canvas.getContext('2d');
  if (b.maskCanvas) ctx.drawImage(b.maskCanvas, 0, 0);
  const cursor = h('div', { class: 'brush-cursor' });
  const stage = h('div', { class: 'mask-stage' }, h('img', { src: b.url, alt: '', draggable: 'false' }), canvas, cursor);
  let brush = Math.round(Math.max(b.width, b.height) / 16);
  let erase = false;
  let last = null;
  const undo = [];

  const fit = () => {
    const s = Math.min(Math.min(innerWidth - 80, 1060) / b.width, (innerHeight - 240) / b.height);
    stage.style.width = `${Math.round(b.width * s)}px`;
    stage.style.height = `${Math.round(b.height * s)}px`;
  };
  fit();
  addEventListener('resize', fit);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * b.width) / r.width, ((e.clientY - r.top) * b.height) / r.height];
  };
  const moveCursor = (e) => {
    const r = stage.getBoundingClientRect();
    const d = (brush * r.width) / b.width;
    Object.assign(cursor.style, { display: 'block', left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px`, width: `${d}px`, height: `${d}px` });
  };
  const stroke = (p) => {
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = '#a594ff';
    ctx.lineWidth = brush;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    if (last) {
      ctx.moveTo(...last);
      ctx.lineTo(...p);
      ctx.stroke();
    } else {
      ctx.arc(p[0], p[1], brush / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    last = p;
  };
  const snapshot = () => {
    undo.push(ctx.getImageData(0, 0, b.width, b.height));
    if (undo.length > 30) undo.shift();
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    snapshot();
    last = null;
    stroke(pos(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    moveCursor(e);
    if (canvas.hasPointerCapture(e.pointerId)) stroke(pos(e));
  });
  canvas.addEventListener('pointerup', () => { last = null; });
  canvas.addEventListener('pointerleave', () => { cursor.style.display = 'none'; });

  const doUndo = () => undo.length && ctx.putImageData(undo.pop(), 0, 0);
  const sizeSlider = slider({ min: 4, max: 400, step: 1, get: () => brush, set: (v) => { brush = v; } });
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
    if (e.key === '[') { brush = Math.max(4, Math.round(brush / 1.2)); sizeSlider.sync(); }
    if (e.key === ']') { brush = Math.min(400, Math.round(brush * 1.2)); sizeSlider.sync(); }
  };
  document.addEventListener('keydown', onKey);

  const done = async () => {
    const q = await quantizeMask(canvas);
    if (b.maskUrl) URL.revokeObjectURL(b.maskUrl);
    Object.assign(b, q ? { mask: q.b64, maskUrl: q.url, maskCanvas: canvas } : { mask: null, maskUrl: null, maskCanvas: null });
    close();
    baseChanged();
    if (q) toast('蒙版已设置，生成时只重绘涂抹区域', 'ok');
  };
  const close = openModal({
    title: '绘制重绘区域',
    wide: true,
    body: [
      h('div', { class: 'mask-tools' },
        seg([[false, '画笔'], [true, '橡皮']], false, (v) => { erase = v; }),
        h('span', { class: 'muted small' }, '笔刷'),
        sizeSlider,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small ghost', type: 'button', onclick: doUndo, title: 'Ctrl+Z' }, icon('undo', 14), '撤销'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { snapshot(); ctx.clearRect(0, 0, b.width, b.height); } }, icon('eraser', 14), '清空')),
      stage,
      h('div', { class: 'hint', style: { margin: 0 } }, '涂抹的区域会被重新生成。[ ] 调整笔刷大小，Ctrl+Z 撤销。'),
    ],
    foot: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: done }, icon('check', 14), '完成'),
    ],
    onClose: () => {
      removeEventListener('resize', fit);
      document.removeEventListener('keydown', onKey);
    },
  });
}

// ---------- 生成 ----------

function setBusyText(t) {
  app.busyLabel = t;
  paintBusyText();
}

function paintBusyText() {
  if (!app.busy) return;
  const q = app.queue;
  $('#busy-text').textContent = app.busyLabel + (q?.waiting ? ` · 队列中还有 ${q.waiting} 个` : '');
}

async function runTask(label, fn) {
  if (app.busy) {
    toast('上一个任务还没结束', 'error');
    return false;
  }
  const ctl = new AbortController();
  app.busy = ctl;
  const t0 = performance.now();
  $('#busy').hidden = false;
  setBusyText(label);
  $('#generate').classList.add('running');
  $('#gen-label').textContent = '取消';
  const timer = setInterval(() => { $('#busy-time').textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`; }, 100);
  setTimeout(pollQueue, 500);
  try {
    await fn(ctl.signal);
    return true;
  } catch (e) {
    if (e.name === 'AbortError') toast('已取消');
    else {
      console.error(e);
      toast(e.message || String(e), 'error', 7000);
    }
    return false;
  } finally {
    clearInterval(timer);
    app.busy = null;
    $('#busy').hidden = true;
    $('#busy-time').textContent = '0.0s';
    $('#generate').classList.remove('running');
    $('#gen-label').textContent = '生成';
    pollQueue();
  }
}

async function extractImages(bytes) {
  const mime = (b) => (b[0] === 0x89 ? 'image/png' : 'image/webp');
  if (isImageBytes(bytes)) return [new Blob([bytes], { type: mime(bytes) })];
  const files = (await unzip(bytes)).filter((f) => isImageBytes(f.data));
  if (!files.length) throw new Error('NAI 返回的数据里没有图片');
  return files.map((f) => new Blob([f.data], { type: mime(f.data) }));
}

async function readNaiMeta(blob) {
  try {
    const t = readPngText(new Uint8Array(await blob.arrayBuffer()));
    return t.Comment ? { ...JSON.parse(t.Comment), _source: t.Source || '' } : null;
  } catch {
    return null;
  }
}

const snapshotParams = (src = S) => structuredClone(pick(src, PARAM_KEYS));

/** 生成用的提示词：去掉停用的词（// 开头），把 __分类__ 换成词库里随机一条 */
function resolvedState() {
  const missing = new Set();
  const pickWild = (name) => {
    const v = library.pickWild(name);
    if (v == null) missing.add(name);
    return v;
  };
  const r = (text) => resolvePrompt(text || '', pickWild);
  const out = {
    ...S,
    prompt: r(S.prompt),
    negative: r(S.negative),
    characters: S.characters.map((c) => ({ ...c, prompt: r(c.prompt), negative: r(c.negative) })),
  };
  if (missing.size) toast(`词库里没有这些分类：${[...missing].join('、')}，对应的随机词会原样发送`, 'error', 6000);
  return out;
}

async function addRecord(blob, info) {
  const owner = app.user?.id;
  const { thumb, width, height } = await makeThumb(blob);
  const rec = { id: uid(), owner, created: Date.now(), blob, thumb, width, height, ...info };
  if (!owner || owner !== app.user?.id) return rec; // 生成途中换了人，不写进下一个人的历史
  try {
    await store.putImage(rec);
  } catch (e) {
    console.warn(e);
    toast('保存到历史失败（浏览器存储不可用或已满）', 'error');
  }
  app.history.unshift(rec);
  renderHistory();
  return rec;
}

async function generate() {
  if (app.busy) {
    app.busy.abort();
    return;
  }
  const R = resolvedState();
  if (!R.prompt.trim() && !R.characters.some((c) => c.enabled && c.prompt.trim())) {
    toast('先写点提示词', 'error');
    $('#prompt').focus();
    return;
  }
  if (S.width % 64 || S.height % 64 || S.width * S.height > N.MAX_PIXELS) {
    toast('尺寸不合法：宽高需为 64 的倍数，且总像素不超过 3.1MP', 'error');
    return;
  }
  const c = caps();
  const seed = S.seed !== '' ? Number(S.seed) : randomSeed();
  const ok = await runTask('生成中', async (signal) => {
    const vibes = c.vibe && S.vibes.length && !(c.charRef && S.charRefs.length) ? await encodeVibes(signal) : [];
    const body = N.buildGenerateBody(R, { seed, vibes });
    setBusyText(body.action === 'infill' ? '局部重绘中' : body.action === 'img2img' ? '图生图中' : '生成中');
    const blobs = await extractImages(await api.generate(body, signal));
    const params = snapshotParams(R);
    const recs = [];
    for (const [i, blob] of blobs.entries()) {
      const meta = await readNaiMeta(blob);
      const tool = body.action === 'infill' ? '重绘' : body.action === 'img2img' ? '图生图' : null;
      recs.push(await addRecord(blob, { kind: 'gen', tool, params: { ...params, seed: meta?.seed ?? seed + i } }));
    }
    showView(recs, 0);
  });
  if (ok) refreshSub();
}

function updateCost() {
  const el = $('#cost');
  if (!app.sub) {
    el.textContent = '';
    return;
  }
  const est = N.estimateCost(S, app.sub);
  const c = caps();
  const usingVibes = c.vibe && S.vibes.length && !(c.charRef && S.charRefs.length);
  const extra = est.extra + (usingVibes ? S.vibes.filter((v) => v.cached === false).length * 2 : 0);
  if (est.kind === 'free') el.textContent = extra ? `免费 + ${extra}` : '免费';
  else if (est.kind === 'allowance') el.textContent = extra ? `额度 + ${extra}` : 'V5 额度';
  else el.textContent = `≈ ${est.base + extra} Anlas`;
  el.title = `${est.discount && S.nSamples > 1 ? `Opus 免掉其中 1 张，其余每张 ${est.per} Anlas。` : ''}${COST_NOTE}`;
}

// ---------- 查看器与工具 ----------

function thumbUrl(rec) {
  let u = app.thumbUrls.get(rec.id);
  if (!u) {
    u = URL.createObjectURL(rec.thumb || rec.blob);
    app.thumbUrls.set(rec.id, u);
  }
  return u;
}

function showView(items, index = 0) {
  app.view = items.length ? { items, index } : null;
  paintView();
}

function paintView() {
  const img = $('#view-img');
  if (app.viewUrl) URL.revokeObjectURL(app.viewUrl);
  app.viewUrl = null;
  const rec = cur();
  $('#viewer').classList.remove('zoom');
  if (!rec) {
    img.hidden = true;
    img.removeAttribute('src');
    $('#empty').hidden = false;
    $('#batch').hidden = true;
    $('#view-meta').textContent = '';
  } else {
    app.viewUrl = URL.createObjectURL(rec.blob);
    img.src = app.viewUrl;
    img.hidden = false;
    $('#empty').hidden = true;
    const { items, index } = app.view;
    $('#batch').hidden = items.length < 2;
    if (items.length > 1) {
      $('#batch').replaceChildren(...items.map((r, i) => h('button', {
        type: 'button', class: i === index ? 'on' : '', onclick: () => { app.view.index = i; paintView(); },
      }, h('img', { src: thumbUrl(r), alt: '' }))),
      h('button', { type: 'button', class: 'batch-dl', title: `打包下载这 ${items.length} 张`, onclick: () => downloadMany(items) }, icon('download', 18)));
    }
    const p = rec.params;
    const meta = $('#view-meta');
    meta.replaceChildren(h('b', {}, `${rec.width}×${rec.height}`));
    if (rec.tool) meta.append(` · ${rec.tool}`);
    if (p) meta.append(` · ${N.modelById(p.modelId).label} ${N.modelById(p.modelId).sub} · seed ${p.seed}`);
    meta.title = p?.prompt || '';
  }
  for (const b of $('#tools').querySelectorAll('button')) b.disabled = !rec || (b.dataset.needParams && !rec.params);
  for (const el of $('#history').children) el.classList.toggle('on', el.dataset.id === rec?.id);
  paintToolCosts();
}

const COST_NOTE = '按 NAI 官网的计价公式估算，以实际扣费为准';
const costText = (c) => (c == null ? '不支持' : c === 0 ? '免费' : `${c} Anlas`);

function upscaleScale(r) {
  const side = Math.max(r.width, r.height);
  const scale = side * 4 <= 4096 ? 4 : 2;
  return side * scale > 4096 ? 0 : scale;
}

function toolCosts(r) {
  if (!r || !app.sub) return null;
  return {
    upscale: upscaleScale(r) ? N.upscaleCost(r.width, r.height) : null,
    director: Object.fromEntries(N.DIRECTOR_TOOLS.map((t) => [t.id, N.directorCost(t.id, r.width, r.height, app.sub)])),
  };
}

function paintToolCosts() {
  const costs = toolCosts(cur());
  for (const b of $('#tools').querySelectorAll('[data-cost]')) {
    const tag = b.querySelector('.tool-cost');
    const label = b.querySelector('span:not(.icon)').textContent;
    if (!costs) {
      tag.textContent = '';
      b.title = label;
      continue;
    }
    if (b.dataset.cost === 'upscale') {
      tag.textContent = costText(costs.upscale);
      b.title = `${label}：${costText(costs.upscale)}（${COST_NOTE}）`;
    } else {
      // 菜单里每项各自标价，按钮上显示区间
      const vals = Object.values(costs.director).filter((c) => c != null);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      tag.textContent = !vals.length ? '不支持' : lo === hi ? costText(lo) : `${lo === 0 ? '免费' : lo}–${hi} Anlas`;
      b.title = `${label}：各工具价格见菜单（${COST_NOTE}）`;
    }
    tag.classList.toggle('free', tag.textContent === '免费');
  }
}

function fileName(r, used) {
  const ext = r.blob.type === 'image/webp' ? 'webp' : 'png';
  const base = `nai-${r.params?.seed ?? r.id}${r.toolId ? `-${r.toolId}` : ''}`;
  let name = `${base}.${ext}`;
  for (let i = 2; used?.has(name); i++) name = `${base}-${i}.${ext}`;
  used?.add(name);
  return name;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadCurrent() {
  saveBlob(cur().blob, fileName(cur()));
}

// 多张打成一个 zip，和官网的批量保存一样，不用一张张点
async function downloadMany(recs) {
  if (!recs.length) return;
  if (recs.length === 1) {
    saveBlob(recs[0].blob, fileName(recs[0]));
    return;
  }
  try {
    const used = new Set();
    const files = [];
    for (const r of recs) {
      files.push({ name: fileName(r, used), data: new Uint8Array(await r.blob.arrayBuffer()), date: new Date(r.created || Date.now()) });
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    saveBlob(zipFiles(files), `nai-${stamp}-${recs.length}.zip`);
    toast(`已打包 ${recs.length} 张图片`, 'ok');
  } catch (e) {
    toast(`打包失败：${e.message}`, 'error');
  }
}

async function copyCurrent() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [cur().blob.type]: cur().blob })]);
    toast('已复制到剪贴板', 'ok');
  } catch {
    toast('复制失败：浏览器不允许（需要 HTTPS 或 localhost）', 'error');
  }
}

async function toolResult(r, blobs, tool, toolId) {
  const recs = [];
  for (const b of blobs) recs.push(await addRecord(b, { kind: 'tool', tool, toolId, params: r.params }));
  showView(recs);
}

async function upscaleCurrent() {
  const r = cur();
  const scale = upscaleScale(r);
  if (!scale) {
    toast('图片已经很大了，不能再放大', 'error');
    return;
  }
  const ok = await runTask(`放大 ${scale}×`, async (signal) => {
    const bytes = await api.upscale({ image: await blobToB64(r.blob), width: r.width, height: r.height, scale }, signal);
    await toolResult(r, await extractImages(bytes), `放大 ${scale}×`, 'upscale');
  });
  if (ok) refreshSub();
}

async function runDirector(tool, extra = {}) {
  const r = cur();
  const ok = await runTask(tool.label, async (signal) => {
    const body = { req_type: tool.id, width: r.width, height: r.height, image: await blobToB64(r.blob), ...extra };
    await toolResult(r, await extractImages(await api.augment(body, signal)), tool.label, tool.id);
  });
  if (ok) refreshSub();
}

function openMenu(anchor, items) {
  const menu = $('#menu');
  menu.replaceChildren(...items.map((it) => h('button', { type: 'button', onclick: () => { closeMenu(); it.run(); } }, it.label, it.hint ? h('small', {}, it.hint) : null)));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  menu.style.left = `${clamp(r.left + r.width / 2 - mw / 2, 8, innerWidth - mw - 8)}px`;
  menu.style.top = `${r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8}px`;
}

function closeMenu() {
  $('#menu').hidden = true;
}

function openDirectorMenu(anchor) {
  const costs = toolCosts(cur());
  openMenu(anchor, N.DIRECTOR_TOOLS.map((t) => ({
    label: t.label,
    hint: costs ? costText(costs.director[t.id]) : '',
    run: () => (t.emotion ? emotionDialog(t) : t.prompt ? colorizeDialog(t) : runDirector(t)),
  })));
}

function defrySlider(state) {
  return field('弱化', slider({ min: 0, max: 5, step: 1, get: () => state.defry, set: (v) => { state.defry = v; } }));
}

function colorizeDialog(tool) {
  const st = { defry: 0 };
  const prompt = h('textarea', { class: 'tag-input', rows: 3, spellcheck: 'false', placeholder: '可选：描述想要的配色，如 blue hair, red eyes, white dress' });
  attachSuggest(prompt);
  const close = openModal({
    title: tool.label,
    body: [prompt, defrySlider(st), h('div', { class: 'hint', style: { margin: 0 } }, '弱化越高，上色效果越轻。')],
    foot: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); runDirector(tool, { prompt: prompt.value.trim(), defry: st.defry }); } }, '开始'),
    ],
  });
  prompt.focus();
}

function emotionDialog(tool) {
  const st = { emotion: 'happy', defry: 0 };
  const grid = h('div', { class: 'emotions' });
  for (const [v, label] of N.EMOTIONS) {
    grid.append(h('button', {
      type: 'button', class: v === st.emotion ? 'on' : '', title: v,
      onclick: (e) => { st.emotion = v; for (const b of grid.children) b.classList.toggle('on', b === e.currentTarget); },
    }, label));
  }
  const extra = h('input', { placeholder: '可选：额外描述，如 blush, tears', spellcheck: 'false' });
  const close = openModal({
    title: tool.label,
    body: [grid, extra, defrySlider(st)],
    foot: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, '取消'),
      h('button', {
        class: 'btn primary', type: 'button',
        onclick: () => { close(); runDirector(tool, { prompt: `${st.emotion};;${extra.value.trim()},`, defry: st.defry }); },
      }, '开始'),
    ],
  });
}

function afterBulkChange() {
  if (S.base) {
    S.width = S.base.width;
    S.height = S.base.height;
  }
  for (const c of S.characters) c.id ||= uid();
  for (const v of S.vibes) v.cached = null;
  checkVibeCache();
  renderAll();
  save();
}

function reuseCurrent() {
  const p = cur().params;
  Object.assign(S, structuredClone(pick(p, PARAM_KEYS.filter((k) => k !== 'seed'))));
  afterBulkChange();
  toast('已复用参数（种子没变，需要的话点「用此种子」）', 'ok');
}

function useSeedCurrent() {
  S.seed = String(cur().params.seed);
  syncControls();
  save();
  toast(`种子已固定为 ${S.seed}`, 'ok');
}

// 把 NAI 官网 / 其他工具写进图片的参数转换成本页的设置
function parseMeta(c) {
  const p = {};
  const v4 = c.v4_prompt?.caption;
  const v4n = c.v4_negative_prompt?.caption;
  let prompt = String(v4?.base_caption ?? c.prompt ?? '').trim();
  p.quality = false;
  for (const suf of N.QUALITY_SUFFIXES) {
    if (prompt.endsWith(suf)) {
      prompt = prompt.slice(0, -suf.length).replace(/[\s,]+$/, '');
      p.quality = true;
      break;
    }
  }
  p.prompt = prompt;
  let neg = String(v4n?.base_caption ?? c.uc ?? '').trim();
  p.ucPreset = 'none';
  for (const pre of [...N.UC_PRESETS].sort((a, b) => b.text.length - a.text.length)) {
    if (pre.text && neg.startsWith(pre.text)) {
      p.ucPreset = pre.id;
      neg = neg.slice(pre.text.length).replace(/^[\s,]+/, '');
      break;
    }
  }
  p.negative = neg;
  const snap = (v) => (typeof v === 'number' ? +clamp(Math.round((v - 0.1) / 0.2) * 0.2 + 0.1, 0.1, 0.9).toFixed(1) : 0.5);
  p.characters = (v4?.char_captions || []).map((cc, i) => ({
    id: uid(), enabled: true, prompt: cc.char_caption || '', negative: v4n?.char_captions?.[i]?.char_caption || '',
    x: snap(cc.centers?.[0]?.x), y: snap(cc.centers?.[0]?.y),
  }));
  p.autoPosition = !c.v4_prompt?.use_coords;
  for (const [k, src] of [['width', 'width'], ['height', 'height'], ['steps', 'steps'], ['scale', 'scale'], ['cfgRescale', 'cfg_rescale']]) {
    if (typeof c[src] === 'number') p[k] = c[src];
  }
  if (N.SAMPLERS.some(([v]) => v === c.sampler)) p.sampler = c.sampler;
  if (N.NOISE_SCHEDULES.includes(c.noise_schedule)) p.noiseSchedule = c.noise_schedule;
  if (typeof c.seed === 'number') p.seed = String(c.seed);
  p.variety = c.skip_cfg_above_sigma != null;
  if (/V5/i.test(c._source) && !model().v5) p.modelId = 'nai-diffusion-5-full';
  else if (/V4\.5/i.test(c._source) && model().v5) p.modelId = 'nai-diffusion-4-5-full';
  return p;
}

// 先读 PNG 文本块，没有的话再读 alpha 通道里的隐写信息
async function readAnyMeta(blob) {
  const meta = await readNaiMeta(blob);
  if (meta) return meta;
  try {
    const s = await readStealthMeta(blob);
    const c = typeof s?.Comment === 'string' ? JSON.parse(s.Comment) : s?.Comment;
    if (c && typeof c === 'object') return { ...c, _source: s.Source || '' };
  } catch (e) {
    console.warn(e);
  }
  return null;
}

// [id, 名称, 对应的设置项, 图片里有没有这一项]
const IMPORT_GROUPS = [
  ['prompt', '提示词', ['prompt', 'quality'], (p) => p.prompt],
  ['negative', '负面提示词', ['negative', 'ucPreset'], (p) => p.negative || p.ucPreset !== 'none'],
  ['characters', '角色', ['characters', 'autoPosition'], (p) => p.characters.length],
  ['settings', '尺寸和参数', ['modelId', 'width', 'height', 'steps', 'scale', 'cfgRescale', 'sampler', 'noiseSchedule', 'variety'], () => true],
  ['seed', '种子', ['seed'], (p) => p.seed],
];

async function handleImported(blob) {
  const rec = app.history.find((r) => r.blob === blob);
  if (rec) {
    showView([rec]);
    return;
  }
  const meta = await readAnyMeta(blob);
  importDialog(blob, meta && (meta.prompt || meta.v4_prompt) ? meta : null);
}

function importDialog(blob, meta) {
  const url = URL.createObjectURL(blob);
  const p = meta ? parseMeta(meta) : null;
  const groups = p ? IMPORT_GROUPS.filter((g) => g[3](p)) : [];
  const picked = new Set(groups.map((g) => g[0]));
  const info = [];
  if (p) {
    const facts = [p.width && p.height ? `${p.width}×${p.height}` : '', p.steps ? `${p.steps} 步` : '',
      p.scale != null ? `CFG ${p.scale}` : '', p.sampler || '', p.seed ? `seed ${p.seed}` : ''].filter(Boolean);
    info.push(h('div', { class: 'import-facts mono' }, facts.join(' · ')));
    if (meta._source) info.push(h('div', { class: 'faint' }, meta._source));
    const block = (label, text) => text && info.push(h('div', { class: 'import-block' }, h('b', {}, label), h('p', {}, text)));
    block('提示词', p.prompt);
    block('负面', p.negative);
    p.characters.forEach((c, i) => block(`角色 ${i + 1}`, c.prompt));
  } else {
    info.push(h('p', { class: 'muted', style: { margin: 0 } }, '这张图里没有找到 NAI 的生成参数（可能被压缩或转存过）。可以把它当作底图或参考图。'));
  }
  const checks = groups.map(([id, label]) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) picked.add(id); else picked.delete(id); } }),
    h('span', {}, label)));
  const act = (fn) => async () => {
    close();
    await fn();
  };
  const useRef = (tab, label, add) => act(async () => {
    if (!caps()[tab]) {
      toast(`当前模型不支持${label}，请先切到 V4.5`, 'error');
      return;
    }
    S.refTab = tab;
    renderTabs();
    await add([blob]);
    save();
  });
  const close = openModal({
    title: p ? '读取图片参数' : '使用这张图片',
    cls: 'import-modal',
    body: [
      h('div', { class: 'import' }, h('img', { class: 'import-img', src: url, alt: '' }), h('div', { class: 'import-info' }, info)),
      checks.length ? h('div', { class: 'import-checks' }, h('span', { class: 'faint' }, '导入：'), checks) : null,
    ],
    foot: [
      h('button', { class: 'btn ghost', type: 'button', onclick: act(() => setBase(blob)) }, '设为底图'),
      h('button', { class: 'btn ghost', type: 'button', onclick: useRef('charRef', '角色参考', addCharRef) }, '角色参考'),
      h('button', { class: 'btn ghost', type: 'button', onclick: useRef('vibe', '氛围迁移', addVibes) }, '氛围参考'),
      p ? h('button', {
        class: 'btn primary', type: 'button',
        onclick: act(async () => {
          const keys = groups.filter((g) => picked.has(g[0])).flatMap((g) => g[2]);
          if (!keys.length) return;
          Object.assign(S, structuredClone(pick(p, keys)));
          afterBulkChange();
          const { width, height } = await makeThumb(blob, 8);
          showView([{ id: uid(), blob, width, height, params: snapshotParams(), tool: '导入' }]);
          toast('已导入所选参数', 'ok');
        }),
      }, '导入参数') : null,
    ],
    onClose: () => setTimeout(() => URL.revokeObjectURL(url), 1000),
  });
}

// ---------- 历史 ----------

async function loadHistory() {
  const user = app.user;
  try {
    const all = await store.allImages();
    if (user !== app.user) return;
    // 旧版本的历史没有记录归属，只交给管理员，其他人看不到
    if (user.admin) {
      for (const r of all.filter((x) => !x.owner)) {
        r.owner = user.id;
        await store.putImage(r).catch(() => {});
      }
    }
    app.history = all.filter((r) => r.owner === user.id);
  } catch (e) {
    console.warn(e);
    app.history = [];
    toast('这个浏览器不能保存本地历史', 'error');
  }
  renderHistory();
  if (!app.view && app.history[0]) showView([app.history[0]]);
}

function renderHistory() {
  const grid = $('#history');
  grid.replaceChildren(...app.history.slice(0, 600).map((rec, idx) => {
    const el = h('div', {
      class: `hist-item${cur()?.id === rec.id ? ' on' : ''}${app.select?.has(rec.id) ? ' sel' : ''}`,
      draggable: 'true',
      title: rec.params?.prompt?.slice(0, 200) || '',
      onclick: (e) => {
        if (app.select) {
          pickRecord(idx, e.shiftKey);
          return;
        }
        const i = app.view?.items.indexOf(rec) ?? -1;
        if (i >= 0) {
          app.view.index = i;
          paintView();
        } else showView([rec]);
      },
    },
    h('img', { src: thumbUrl(rec), alt: '', loading: 'lazy', draggable: 'false' }),
    rec.tool ? h('span', { class: 'tag' }, rec.tool) : null,
    h('span', { class: 'chk' }, icon('check', 13)),
    h('button', { class: 'del', type: 'button', title: '删除', onclick: (e) => { e.stopPropagation(); deleteRecord(rec); } }, icon('x', 12)));
    el.dataset.id = rec.id;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-nai-id', rec.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    return el;
  }));
  $('#hist-count').textContent = app.history.length || '';
  $('#hist-empty').hidden = app.history.length > 0;
  renderHistBar();
}

// ---------- 历史多选：批量下载 / 删除 ----------

function setSelecting(on) {
  app.select = on ? new Set() : null;
  app.lastPick = -1;
  renderHistory();
}

function pickRecord(idx, range) {
  const ids = app.history.map((r) => r.id);
  if (range && app.lastPick >= 0) {
    const [a, b] = [Math.min(app.lastPick, idx), Math.max(app.lastPick, idx)];
    for (let i = a; i <= b; i++) app.select.add(ids[i]);
  } else if (app.select.has(ids[idx])) app.select.delete(ids[idx]);
  else app.select.add(ids[idx]);
  app.lastPick = idx;
  for (const el of $('#history').children) el.classList.toggle('sel', app.select.has(el.dataset.id));
  renderHistBar();
}

function renderHistBar() {
  const bar = $('#hist-bar');
  $('.history').classList.toggle('selecting', !!app.select);
  $('#hist-select').classList.toggle('on', !!app.select);
  bar.hidden = !app.select;
  if (!app.select) return;
  const n = app.select.size;
  const all = n > 0 && n === app.history.length;
  const chosen = () => app.history.filter((r) => app.select.has(r.id));
  bar.replaceChildren(
    h('div', { class: 'hist-bar-top' },
      h('span', {}, `已选 ${n} / ${app.history.length}`),
      h('button', {
        class: 'text-btn', type: 'button',
        onclick: () => { app.select = all ? new Set() : new Set(app.history.map((r) => r.id)); renderHistory(); },
      }, all ? '全不选' : '全选')),
    h('div', { class: 'hist-bar-btns' },
      h('button', { class: 'btn primary small', type: 'button', disabled: !n, onclick: () => downloadMany(chosen()) }, icon('download', 14), h('span', {}, '下载')),
      h('button', { class: 'btn ghost small', type: 'button', title: '删除选中', disabled: !n, onclick: () => deleteRecords(chosen()) }, icon('trash', 14)),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => setSelecting(false) }, '完成')),
  );
}

async function forgetRecords(recs) {
  const gone = new Set(recs);
  for (const r of recs) {
    await store.deleteImage(r.id).catch(() => {});
    const u = app.thumbUrls.get(r.id);
    if (u) URL.revokeObjectURL(u);
    app.thumbUrls.delete(r.id);
    app.select?.delete(r.id);
  }
  app.history = app.history.filter((r) => !gone.has(r));
  if (app.view?.items.some((r) => gone.has(r))) {
    const items = app.view.items.filter((r) => !gone.has(r));
    showView(items, Math.max(0, Math.min(app.view.index, items.length - 1)));
  }
  renderHistory();
}

const deleteRecord = (rec) => forgetRecords([rec]);

async function deleteRecords(recs) {
  if (!recs.length || !(await confirmDialog(`删除选中的 ${recs.length} 张图片？只影响本浏览器。`, '删除'))) return;
  await forgetRecords(recs);
}

async function clearHistory() {
  if (!app.history.length || !(await confirmDialog(`删除你的全部 ${app.history.length} 张历史图片？只影响本浏览器。`, '全部删除'))) return;
  await forgetRecords([...app.history]);
}

function navigate(delta) {
  const v = app.view;
  if (!v) return;
  if (v.items.length > 1) {
    v.index = (v.index + delta + v.items.length) % v.items.length;
    paintView();
    return;
  }
  const i = app.history.findIndex((r) => r.id === cur().id);
  const next = app.history[i + delta];
  if (i >= 0 && next) showView([next]);
}

// ---------- 提示词补全 ----------

const sug = { ta: null, items: [], index: 0, ctl: null, skip: false, fallback: false };

function tokenAt(ta) {
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return null;
  const text = ta.value;
  let start = pos;
  while (start > 0 && !/[,\n|]/.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && !/[,\n|{}[\]:]/.test(text[end])) end++;
  const raw = text.slice(start, pos);
  const lead = raw.match(/^\s*(?:\/\/)?\s*(?:-?[\d.]+::)?[\s{}[\]]*/)[0];
  const word = raw.slice(lead.length);
  const w = word.trim();
  if ((w.length < 2 && !CJK.test(w)) || /::|[{}[\]]/.test(word)) return null;
  return { start: start + lead.length, end, word: word.trim() };
}

function attachSuggest(ta) {
  ta.addEventListener('input', () => {
    if (sug.skip) {
      sug.skip = false;
      return;
    }
    requestSuggest(ta);
  });
  ta.addEventListener('keydown', (e) => onSuggestKey(e, ta));
  ta.addEventListener('blur', () => setTimeout(() => sug.ta === ta && closeSuggest(), 150));
}

const requestSuggest = debounce(async (ta) => {
  const tok = tokenAt(ta);
  sug.ctl?.abort();
  if (!tok) {
    closeSuggest();
    return;
  }
  const ctl = (sug.ctl = new AbortController());
  const cn = CJK.test(tok.word);
  try {
    let tags;
    if (cn) {
      // 输入中文：查本地中英词库，选中后填英文 TAG
      const res = await api.tagSearch(tok.word, null, 12, ctl.signal);
      tags = res.items.map((t) => ({ tag: toPrompt(t.name), count: t.count, cn: t.cn, cat: t.cat }));
    } else {
      const res = await api.suggestTags(sug.fallback ? 'nai-diffusion-4-5-full' : S.modelId, tok.word, ctl.signal);
      tags = (res.tags || []).slice(0, 12).map((t) => ({ ...t, cn: tagPanel.cnOf(t.tag) }));
    }
    if (ctl.signal.aborted || document.activeElement !== ta) return;
    if (!tags.length) {
      closeSuggest();
      return;
    }
    Object.assign(sug, { ta, items: tags, index: 0 });
    paintSuggest();
    if (!cn && tags.some((t) => !t.cn) && (await tagPanel.translate(tags.map((t) => t.tag)))) {
      if (sug.ta !== ta || sug.items !== tags) return;
      for (const t of tags) t.cn = tagPanel.cnOf(t.tag);
      paintSuggest();
    }
  } catch (e) {
    // 某些模型可能没有补全数据，退回 V4.5 的词库
    if (!cn && e.name !== 'AbortError' && e.status >= 400 && e.status < 500 && !sug.fallback) sug.fallback = true;
    if (e.name !== 'AbortError') closeSuggest();
  }
}, 200);

function paintSuggest() {
  const el = $('#suggest');
  el.replaceChildren(...sug.items.map((t, i) => h('div', {
    class: `sg-item${i === sug.index ? ' on' : ''}`,
    onmousedown: (e) => { e.preventDefault(); pickSuggest(i); },
  }, h('span', { class: 'sg-tag' }, t.tag, t.cn ? h('small', {}, t.cn) : null), h('span', { class: 'n' }, fmtCount(t.count)))));
  el.hidden = false;
  const r = sug.ta.getBoundingClientRect();
  el.style.left = `${r.left}px`;
  el.style.width = `${Math.max(220, r.width)}px`;
  const below = innerHeight - r.bottom;
  if (below < 200 && r.top > below) {
    el.style.top = '';
    el.style.bottom = `${innerHeight - r.top + 4}px`;
  } else {
    el.style.bottom = '';
    el.style.top = `${r.bottom + 4}px`;
  }
  // 不用 scrollIntoView：它会连带滚动整个页面
  const on = el.children[sug.index];
  if (on.offsetTop < el.scrollTop) el.scrollTop = on.offsetTop;
  else if (on.offsetTop + on.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = on.offsetTop + on.offsetHeight - el.clientHeight;
}

function closeSuggest() {
  sug.ta = null;
  sug.items = [];
  $('#suggest').hidden = true;
}

function onSuggestKey(e, ta) {
  if (sug.ta !== ta || !sug.items.length || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sug.index = (sug.index + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    paintSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickSuggest(sug.index);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    closeSuggest();
  }
}

function pickSuggest(i) {
  const ta = sug.ta;
  const tag = sug.items[i]?.tag;
  const tok = ta && tokenAt(ta);
  if (!tag || !tok) return closeSuggest();
  const after = ta.value.slice(tok.end);
  const sep = /^\s*,/.test(after) ? '' : ', ';
  ta.value = ta.value.slice(0, tok.start) + tag + sep + after;
  const caret = tok.start + tag.length + sep.length;
  ta.setSelectionRange(caret, caret);
  sug.skip = true;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  closeSuggest();
}

// ---------- 账户 / 队列 / 登录 ----------

async function refreshSub() {
  try {
    app.sub = N.parseSubscription(await api.subscription());
    $('#stat-anlas').title = 'Anlas 余额';
  } catch (e) {
    $('#stat-anlas').title = `账户信息获取失败：${e.message}`;
    if (!app.subWarned) toast(`账户信息获取失败：${e.message}`, 'error', 6000);
    app.subWarned = true;
  }
  const s = app.sub;
  $('#anlas').textContent = s ? s.anlas.toLocaleString() : '—';
  $('#tier').textContent = s ? (s.active ? N.TIER_NAMES[s.tier] || `T${s.tier}` : '未订阅') : '';
  const u = s?.usage;
  $('#stat-usage').hidden = !u;
  if (u) {
    const pct = u.isNegative ? 0 : clamp(u.percent, 0, 100);
    $('#usage-bar').style.width = `${pct}%`;
    $('#usage-text').textContent = `${Math.round(pct)}%`;
    $('#stat-usage .battery').classList.toggle('low', pct < 10);
  }
  updateCost();
  paintToolCosts();
}

async function pollQueue() {
  const el = $('#stat-queue');
  try {
    app.queue = (await api.me()).queue;
    const q = app.queue;
    el.className = `stat ${q.busy || q.waiting ? 'busy' : 'idle'}`;
    $('#queue-text').textContent = q.busy ? (q.waiting ? `生成中 · 排队 ${q.waiting}` : '生成中') : '空闲';
  } catch {
    el.className = 'stat down';
    $('#queue-text').textContent = '离线';
  }
  paintBusyText();
}

// 读取当前用户自己的设置；旧版本所有人共用一份，只迁移给管理员
function loadUserState() {
  let saved = safeStorage(stateKey());
  const legacy = safeStorage(STATE_STORAGE);
  if (legacy && app.user.admin) {
    saved ||= legacy;
    safeStorage(STATE_STORAGE, null);
  }
  Object.assign(S, defaults(), pick(saved || {}, PERSIST));
  if (!N.MODELS.some((m) => m.id === S.modelId)) S.modelId = defaults().modelId;
  if (!Array.isArray(S.characters)) S.characters = [];
  for (const c of S.characters) c.id ||= uid();
  renderAll();
  persist();
}

// 退出或换人时清掉上一个人的界面，避免看到别人的图和提示词
function resetUserView() {
  app.select = null;
  for (const u of app.thumbUrls.values()) URL.revokeObjectURL(u);
  app.thumbUrls.clear();
  app.history = [];
  showView([]);
  renderHistory();
  library.reset();
  resetHistories();
  Object.assign(S, defaults());
  renderAll();
  for (const id of ['#user-name', '#user-avatar']) $(id).textContent = '';
  $('#manage-link').hidden = true;
}

async function enter() {
  const me = await api.me();
  safeStorage(KEY_STORAGE, app.key);
  resetUserView();
  app.user = { id: me.id || me.user, name: me.user, admin: !!me.is_admin };
  loadUserState();
  library.load();
  $('#login').hidden = true;
  $('#user-name').textContent = me.user;
  $('#manage-link').hidden = !me.is_admin;
  $('#user-avatar').textContent = me.user.slice(0, 1);
  app.queue = me.queue;
  pollQueue();
  refreshSub();
  loadHistory();
  clearInterval(app.pollTimer);
  app.pollTimer = setInterval(() => !document.hidden && pollQueue(), 4000);
}

function showLogin(err = '') {
  $('#login').hidden = false;
  $('#login-error').textContent = err;
  setTimeout(() => $('#login-key').focus(), 50);
}

function logout(msg = '') {
  persist();
  safeStorage(KEY_STORAGE, null);
  app.key = '';
  app.user = null;
  clearInterval(app.pollTimer);
  app.busy?.abort();
  resetUserView();
  tagPanel.reset();
  showLogin(msg);
}

async function onLogin(e) {
  e.preventDefault();
  const key = $('#login-key').value.trim();
  if (!key) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  app.key = key;
  try {
    await enter();
    $('#login-key').value = '';
  } catch (err) {
    app.key = '';
    $('#login-error').textContent = err.status === 401 ? '密钥不对' : err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 全局事件 ----------

const modalOpen = () => !!document.querySelector('.overlay:not(#login)');
const inEditable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function setupGlobal() {
  addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files') && !e.dataTransfer?.types.includes('text/x-nai-id')) return;
    if (modalOpen()) return;
    dragDepth++;
    $('#drop-hint').hidden = false;
  });
  addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-hint').hidden = true;
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    e.preventDefault();
    resetDrop();
    if (modalOpen()) return;
    const [blob] = await blobsFromDrop(e);
    if (blob) handleImported(blob);
  });
  addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file && !modalOpen()) {
      e.preventDefault();
      handleImported(file);
    }
  });
  addEventListener('mousedown', (e) => {
    if (!$('#menu').hidden && !$('#menu').contains(e.target)) closeMenu();
  });
  addEventListener('resize', () => { closeMenu(); closeSuggest(); });
  addEventListener('pagehide', persist);
  $('.controls-scroll').addEventListener('scroll', closeSuggest);
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if ($('#login').hidden && !modalOpen() && !app.busy) generate();
      return;
    }
    if (e.key === 'Escape') {
      closeMenu();
      $('#viewer').classList.remove('zoom');
      if (app.select && !modalOpen()) setSelecting(false);
    }
    if (inEditable(e.target) || modalOpen()) return;
    if (e.key === 'ArrowLeft') navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  });
}

async function boot() {
  buildStatic();
  bindControls();
  setupGlobal();
  renderAll();
  paintView();
  if (!app.key) {
    showLogin();
    return;
  }
  try {
    await enter();
  } catch (e) {
    showLogin(e.status === 401 ? '密钥已失效，请重新输入' : e.message);
  }
}

boot();
