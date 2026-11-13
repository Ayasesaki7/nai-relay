// 参考素材库：氛围参考（Vibe）和角色参考图存在服务器上（每个中转 key 一份），
// 按分类整理，一键用于当前生图；氛围的编码结果也存在服务器，换设备不用再花 Anlas 编码。
import { h, icon, b64ToBytes, blobToB64, bytesToB64 } from './util.js';

export const KIND_LABEL = { vibe: '氛围参考', ref: '角色参考' };
// 官网 .naiv4vibe 文件里用的模型名
const NAI_MODEL_KEYS = {
  'nai-diffusion-4-full': 'v4full',
  'nai-diffusion-4-curated-preview': 'v4curated',
  'nai-diffusion-4-5-full': 'v4-5full',
  'nai-diffusion-4-5-curated': 'v4-5curated',
};
const MODEL_OF_KEY = Object.fromEntries(Object.entries(NAI_MODEL_KEYS).map(([a, b]) => [b, a]));
const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const round2 = (x) => Math.round(x * 100) / 100;
const clampInfo = (x) => Math.min(1, Math.max(0.01, round2(+x || 1)));
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function sha256Hex(bytes) {
  if (!crypto?.subtle) return Array.from({ length: 64 }, () => '0').join('');
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBlob(s, type = 'image/png') {
  const m = /^data:([^;,]+)?(?:;base64)?,/.exec(s);
  return new Blob([b64ToBytes(m ? s.slice(m[0].length) : s)], { type: m?.[1] || type });
}

/** 官网氛围文件（.naiv4vibe 的一项）→ 我们的导入条目 */
function fromNaiVibe(v) {
  const encodings = [];
  for (const [mk, byHash] of Object.entries(v.encodings || {})) {
    const model = MODEL_OF_KEY[mk] || (/^nai-diffusion-/.test(mk) ? mk : null);
    if (!model || !byHash || typeof byHash !== 'object') continue;
    for (const e of Object.values(byHash)) {
      if (typeof e?.encoding === 'string' && e.encoding) encodings.push({ model, info: clampInfo(e.params?.information_extracted ?? 1), data: e.encoding });
    }
  }
  const imp = v.importInfo || {};
  return {
    kind: 'vibe',
    blob: typeof v.image === 'string' && v.image ? b64ToBlob(v.image) : null,
    thumbBlob: typeof v.thumbnail === 'string' && v.thumbnail ? b64ToBlob(v.thumbnail, 'image/jpeg') : null,
    name: typeof v.name === 'string' ? v.name : '',
    category: typeof v.category === 'string' ? v.category : '',
    params: { strength: imp.strength ?? 0.6, info: clampInfo(imp.information_extracted ?? 1) },
    encodings,
  };
}

/** 读导入文件 → 条目列表；看不懂返回 null */
export function parseImport(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.identifier === 'novelai-vibe-transfer') return [fromNaiVibe(json)];
  if (json.identifier === 'novelai-vibe-transfer-bundle' && Array.isArray(json.vibes)) return json.vibes.filter((v) => v && typeof v === 'object').map(fromNaiVibe);
  if (json.identifier === 'nai-relay-assets' && Array.isArray(json.items)) {
    return json.items.filter((x) => x && (x.kind === 'vibe' || x.kind === 'ref')).map((x) => ({
      kind: x.kind,
      blob: typeof x.image === 'string' && x.image ? b64ToBlob(x.image, x.mime || 'image/png') : null,
      thumbBlob: null,
      name: typeof x.name === 'string' ? x.name : '',
      category: typeof x.category === 'string' ? x.category : '',
      params: x.params && typeof x.params === 'object' ? x.params : {},
      encodings: (Array.isArray(x.encodings) ? x.encodings : [])
        .filter((e) => e && typeof e.model === 'string' && typeof e.data === 'string')
        .map((e) => ({ model: e.model, info: clampInfo(e.info), data: e.data })),
    }));
  }
  return null;
}

/**
 * deps: api, toast, openModal, confirmDialog, openMenu, makeThumb, saveBlob,
 *       inUse(item)       这个素材是否正用在当前生图里
 *       use(items)        用于当前生图
 *       unuse(item)       从当前生图里拿掉
 *       modelName(id)     模型显示名
 */
export function createAssets(deps) {
  const st = { state: 'idle', items: [], used: 0, quota: 0, gen: 0, loading: null, error: '' };
  const thumbs = new Map(); // id → url
  const ui = { close: null, kind: 'vibe', cat: 'all', q: '', sel: null };
  const { api, toast } = deps;

  const byId = (id) => st.items.find((x) => x.id === id);
  const label = (x) => x.name || '未命名';
  const cats = (kind) => [...new Set(st.items.filter((x) => x.kind === kind && x.category).map((x) => x.category))].sort((a, b) => a.localeCompare(b, 'zh'));

  function apply(s) {
    if (s && 'used' in s) st.used = s.used;
    if (s && 'quota' in s) st.quota = s.quota;
  }

  async function load(force = false) {
    if (st.state === 'ready' && !force) return true;
    if (st.loading) return st.loading;
    const gen = st.gen;
    if (st.state !== 'ready') st.state = 'loading';
    st.loading = api.assetList().then((d) => {
      if (gen !== st.gen) return false;
      Object.assign(st, { state: 'ready', items: d.items });
      apply(d);
      return true;
    }).catch((e) => {
      if (gen !== st.gen) return false;
      if (st.state !== 'ready') st.state = 'failed';
      st.error = e.message;
      return false;
    }).finally(() => {
      if (gen === st.gen) st.loading = null;
      paint();
    });
    paint();
    return st.loading;
  }

  function reset() {
    st.gen++;
    ui.close?.();
    Object.assign(st, { state: 'idle', items: [], used: 0, quota: 0, loading: null });
    for (const u of thumbs.values()) URL.revokeObjectURL(u);
    thumbs.clear();
    Object.assign(ui, { kind: 'vibe', cat: 'all', q: '', sel: null });
  }

  function upsert(item) {
    const i = st.items.findIndex((x) => x.id === item.id);
    if (i >= 0) st.items[i] = item;
    else st.items.unshift(item);
  }

  // ---------- 新增 / 编码 ----------

  /**
   * 存一个素材。entry: { kind, blob, thumbBlob, name, category, params, encodings: [{model, info, data(b64)}] }
   * 已经存过（同一张图）就把缺的编码补上，返回已有的那条。
   */
  async function add(entry) {
    if (!(await load())) throw new Error(`素材库载入失败：${st.error}`);
    const gen = st.gen;
    let thumb = entry.thumbBlob || null;
    let dims = {};
    if (entry.blob) {
      const t = await deps.makeThumb(entry.blob);
      thumb = t.thumb;
      dims = { width: t.width, height: t.height };
    }
    const meta = { kind: entry.kind, name: entry.name || '', category: entry.category || '', params: entry.params || {}, encodings: entry.encodings || [], ...dims };
    const r = await api.assetAdd(meta, thumb, entry.blob);
    if (gen !== st.gen) throw new Error('已切换用户');
    apply(r);
    upsert(r.item);
    if (r.existed) {
      for (const e of entry.encodings || []) {
        if (!r.item.encodings.some((x) => x.model === e.model && x.info === e.info)) await putEncoding(r.item.id, e.model, e.info, b64ToBytes(e.data)).catch(() => {});
      }
    }
    paint();
    return { item: byId(r.item.id) || r.item, existed: r.existed };
  }

  async function putEncoding(id, model, info, bytes) {
    const gen = st.gen;
    const r = await api.assetPutEncoding(id, model, info, bytes);
    if (gen !== st.gen) return;
    apply(r);
    upsert(r.item);
    paint();
  }

  /** 服务器上有没有这份编码；有就取回（字节），没有返回 null */
  async function getEncoding(id, model, info) {
    const it = byId(id);
    if (!it?.encodings.some((e) => e.model === model && e.info === round2(info))) return null;
    try {
      return await api.assetEncoding(id, model, info);
    } catch {
      return null;
    }
  }

  async function updateParams(id, params) {
    const r = await api.assetUpdate(id, { params });
    upsert(r.item);
    paint();
    return r.item;
  }

  // ---------- 整理 ----------

  async function rename(x) {
    const name = prompt('素材名称', x.name)?.trim();
    if (name == null || name === x.name) return;
    try {
      upsert((await api.assetUpdate(x.id, { name })).item);
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
  }

  async function move(ids, category) {
    try {
      apply(await api.assetBatch('move', ids, category));
      for (const id of ids) {
        const x = byId(id);
        if (x) x.category = category;
      }
      toast(`已移到「${category || '未分类'}」`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
  }

  /** 选分类（含「未分类」和「新建分类…」），选完调用 done(name) */
  function pickCategory(anchor, kind, done, current) {
    const mark = (c) => (current === c ? '当前' : '');
    deps.openMenu(anchor, [
      { label: '未分类', hint: mark(''), run: () => done('') },
      ...cats(kind).map((c) => ({ label: c, hint: mark(c), run: () => done(c) })),
      { label: '新建分类…', run: () => { const c = prompt('新分类名称（如：画风、角色、场景）')?.trim().slice(0, 30); if (c) done(c); } },
    ]);
  }

  async function renameCategory(kind, from) {
    const to = prompt('分类改名', from)?.trim().slice(0, 30);
    if (!to || to === from) return;
    const ids = st.items.filter((x) => x.kind === kind && x.category === from).map((x) => x.id);
    await move(ids, to);
    ui.cat = to;
    paint();
  }

  async function remove(ids) {
    if (!ids.length || !(await deps.confirmDialog(`从素材库删除 ${ids.length} 个素材？服务器上的图片和已存的氛围编码会一起删掉，不能恢复。`, '删除'))) return;
    try {
      apply(await api.assetBatch('delete', ids));
      const gone = new Set(ids);
      st.items = st.items.filter((x) => !gone.has(x.id));
      for (const id of ids) {
        if (thumbs.has(id)) URL.revokeObjectURL(thumbs.get(id));
        thumbs.delete(id);
        ui.sel?.delete(id);
      }
      toast(`已删除 ${ids.length} 个`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
  }

  // ---------- 导入 / 导出 ----------

  async function encodingsOf(x) {
    const out = [];
    for (const e of x.encodings) {
      const bytes = await api.assetEncoding(x.id, e.model, e.info);
      out.push({ ...e, bytes });
    }
    return out;
  }

  async function naiVibeEntry(x) {
    const image = x.size ? await blobToB64(await api.assetFile(x.id)) : undefined;
    const thumb = x.tsize ? await api.assetFile(x.id, true).catch(() => null) : null;
    const encodings = {};
    for (const e of await encodingsOf(x)) {
      const key = NAI_MODEL_KEYS[e.model] || e.model;
      const data = bytesToB64(e.bytes);
      (encodings[key] ||= {})[await sha256Hex(e.bytes)] = { encoding: data, params: { information_extracted: e.info }, type: 'encoding' };
    }
    const firstModel = x.encodings[0]?.model;
    return {
      identifier: 'novelai-vibe-transfer',
      version: 1,
      type: image ? 'image' : 'encoding',
      ...(image ? { image } : {}),
      id: x.sha,
      encodings,
      name: x.name || '',
      category: x.category || undefined,
      ...(thumb ? { thumbnail: `data:${thumb.type || 'image/webp'};base64,${await blobToB64(thumb)}` } : {}),
      createdAt: x.created,
      importInfo: { model: firstModel || 'nai-diffusion-4-5-full', information_extracted: x.params.info, strength: x.params.strength },
    };
  }

  async function exportItems(items) {
    if (!items.length) return;
    const slow = setTimeout(() => toast('正在从服务器打包…', 'info', 2000), 400);
    try {
      let json;
      let name;
      if (items.every((x) => x.kind === 'vibe')) {
        const vibes = [];
        for (const x of items) vibes.push(await naiVibeEntry(x));
        if (vibes.length === 1) {
          json = vibes[0];
          name = `${(items[0].name || 'vibe').replace(/[\\/:*?"<>|]+/g, '_')}.naiv4vibe`;
        } else {
          json = { identifier: 'novelai-vibe-transfer-bundle', version: 1, vibes };
          name = `氛围参考-${today()}.naiv4vibebundle`;
        }
      } else {
        const out = [];
        for (const x of items) {
          const img = x.size ? await api.assetFile(x.id) : null;
          out.push({
            kind: x.kind, name: x.name, category: x.category, params: x.params,
            image: img ? await blobToB64(img) : undefined, mime: x.type || undefined,
            encodings: x.kind === 'vibe' ? (await encodingsOf(x)).map((e) => ({ model: e.model, info: e.info, data: bytesToB64(e.bytes) })) : [],
          });
        }
        json = { identifier: 'nai-relay-assets', version: 1, items: out };
        name = `参考素材-${today()}.json`;
      }
      deps.saveBlob(new Blob([JSON.stringify(json)], { type: 'application/json' }), name);
    } catch (e) {
      toast(`导出失败：${e.message}`, 'error');
    } finally {
      clearTimeout(slow);
    }
  }

  function pickFiles() {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', multiple: true, accept: 'image/*,.naiv4vibe,.naiv4vibebundle,.json' });
      input.onchange = () => resolve([...input.files]);
      input.click();
    });
  }

  /** 导入：图片按当前页签（氛围 / 角色参考）存；.naiv4vibe(bundle) 和本站导出的 .json 按文件内容存 */
  async function importFiles(files) {
    const cat = ui.cat === 'all' ? '' : ui.cat;
    const entries = [];
    let bad = 0;
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        entries.push({ kind: ui.kind, blob: f, name: f.name.replace(/\.[^.]+$/, '').slice(0, 60), category: cat, params: {}, encodings: [] });
        continue;
      }
      try {
        const list = parseImport(JSON.parse(await f.text()));
        if (!list) throw new Error();
        entries.push(...list);
      } catch {
        bad++;
      }
    }
    let added = 0;
    let had = 0;
    for (const [i, e] of entries.entries()) {
      if (entries.length > 2) toast(`正在导入 ${i + 1} / ${entries.length}`, 'info', 1200);
      try {
        const r = await add(e);
        if (r.existed) had++;
        else added++;
      } catch (err) {
        toast(`导入失败：${err.message}`, 'error', 6000);
        break;
      }
    }
    if (bad) toast(`${bad} 个文件看不懂，只支持图片、.naiv4vibe、.naiv4vibebundle 和本站导出的 .json`, 'error', 6000);
    if (added || had) toast(`导入了 ${added} 个素材${had ? `，${had} 个之前已有` : ''}`, 'ok');
    const kinds = new Set(entries.map((e) => e.kind));
    if (kinds.size === 1) ui.kind = [...kinds][0];
    paint();
  }

  // ---------- 界面 ----------

  function open(kind) {
    if (kind) ui.kind = kind;
    if (!ui.close) {
      ui.root = h('div', { class: 'gal ast' });
      const opts = {
        title: '参考素材库',
        wide: true,
        cls: 'lib-modal gal-modal',
        body: ui.root,
        onClose: () => { ui.close = null; ui.sel = null; },
      };
      ui.close = deps.openPage?.(opts) || deps.openModal(opts);
      ui.root.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
      ui.root.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const files = [...e.dataTransfer.files];
        if (files.length) importFiles(files);
      });
    }
    load(true);
    paint();
  }

  function visible() {
    const q = ui.q.trim().toLowerCase();
    return st.items.filter((x) => x.kind === ui.kind
      && (ui.cat === 'all' || x.category === ui.cat)
      && (!q || `${x.name}\n${x.category}`.toLowerCase().includes(q)));
  }

  function loadThumb(x, img) {
    if (thumbs.has(x.id)) {
      img.src = thumbs.get(x.id);
      return;
    }
    const gen = st.gen;
    api.assetFile(x.id, true).then((b) => {
      if (gen !== st.gen) return;
      if (!thumbs.has(x.id)) thumbs.set(x.id, URL.createObjectURL(b));
      img.src = thumbs.get(x.id);
    }).catch(() => img.classList.add('broken'));
  }

  function paint() {
    if (!ui.close) return;
    const root = ui.root;
    const focused = document.activeElement?.classList.contains('gal-search');
    if (st.state === 'loading' || st.state === 'idle') return root.replaceChildren(h('div', { class: 'lib-empty' }, '载入中…'));
    if (st.state === 'failed') {
      return root.replaceChildren(h('div', { class: 'lib-empty' }, `载入失败：${st.error}`, h('br'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => load(true) }, '重试')));
    }
    if (ui.cat !== 'all' && !cats(ui.kind).includes(ui.cat)) ui.cat = 'all';

    const pct = st.quota ? Math.min(100, (st.used / st.quota) * 100) : 0;
    const usage = h('div', { class: 'gal-usage' },
      h('span', {}, `${st.items.length} 个素材 · 已用 ${fmtSize(st.used)} / ${fmtSize(st.quota)}`),
      h('div', { class: `gal-meter${pct > 90 ? ' full' : ''}` }, h('i', { style: { width: `${pct}%` } })));

    const kinds = h('div', { class: 'seg ast-kinds' }, ...Object.entries(KIND_LABEL).map(([k, l]) => h('button', {
      type: 'button', class: ui.kind === k ? 'on' : '', 'data-kind': k,
      onclick: () => { ui.kind = k; ui.cat = 'all'; ui.sel &&= new Set(); paint(); },
    }, l, h('small', {}, ` ${st.items.filter((x) => x.kind === k).length}`))));

    const search = h('input', { type: 'search', class: 'gal-search', placeholder: '按名称、分类搜索…', value: ui.q, spellcheck: 'false' });
    search.addEventListener('input', () => { ui.q = search.value; paintGrid(); });
    const tools = h('div', { class: 'lib-tools' }, search,
      h('button', { type: 'button', class: 'btn small ghost ast-import', title: '导入图片、官网的 .naiv4vibe / .naiv4vibebundle，或本站导出的 .json（也可以直接拖进来）', onclick: async () => importFiles(await pickFiles()) }, icon('upload', 14), '导入'),
      h('button', { type: 'button', class: `btn small ghost${ui.sel ? ' on' : ''}`, onclick: () => { ui.sel = ui.sel ? null : new Set(); paint(); } }, ui.sel ? '完成' : '批量'));

    const inKind = st.items.filter((x) => x.kind === ui.kind);
    const chip = (c, text) => h('button', {
      type: 'button', class: `chip small${ui.cat === c ? ' on' : ''}`, 'data-cat': c,
      onclick: () => { ui.cat = c; ui.sel &&= new Set(); paint(); },
    }, text, h('small', {}, c === 'all' ? inKind.length : inKind.filter((x) => x.category === c).length));
    const catRow = h('div', { class: 'lib-cats' }, chip('all', '全部'),
      ...(inKind.some((x) => !x.category) && cats(ui.kind).length ? [chip('', '未分类')] : []),
      ...cats(ui.kind).map((c) => chip(c, c)));
    const catBar = ui.cat && ui.cat !== 'all' ? h('div', { class: 'lib-catbar' },
      h('span', { class: 'faint' }, `分类「${ui.cat}」`), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => deps.use(visible()) }, '全部用上'),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => renameCategory(ui.kind, ui.cat) }, '改名')) : null;

    ui.grid = h('div', { class: 'ast-grid' });
    ui.batch = h('div', { class: 'gal-batch' });
    const hint = h('div', { class: 'hint' }, ui.kind === 'vibe'
      ? '点一下用于当前生图，再点一下取消。氛围参考编码过一次后，编码会存在这里，换电脑、换浏览器再用也不用再花 2 Anlas。'
      : '点一下用于当前生图（角色参考同时只能用一张）。');
    root.replaceChildren(...[usage, kinds, tools, catRow, catBar, ui.batch, ui.grid, hint].filter(Boolean));
    paintGrid();
    if (focused) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  function paintGrid() {
    if (!ui.grid) return;
    const list = visible();
    paintBatch(list);
    const tiles = list.map((x) => {
      const using = deps.inUse(x);
      const img = x.tsize ? h('img', { alt: '', draggable: 'false' }) : icon(x.kind === 'vibe' ? 'sparkles' : 'user', 28);
      if (x.tsize) loadThumb(x, img);
      const encs = x.encodings.map((e) => `${deps.modelName(e.model)} · 信息量 ${e.info}`);
      const sub = x.kind === 'vibe'
        ? `强度 ${x.params.strength} · 信息量 ${x.params.info}${x.encodings.length ? ' · 已编码' : ''}`
        : `${{ character: '角色', style: '风格', 'character&style': '角色+风格' }[x.params.type]} · 强度 ${x.params.strength}`;
      const tip = [label(x), x.category ? `分类：${x.category}` : '', encs.length ? `已存编码：\n${encs.join('\n')}` : '', x.size ? '' : '（只有编码，没有原图）'].filter(Boolean).join('\n');
      const more = h('button', { type: 'button', class: 'gal-more', title: '更多', onclick: (e) => { e.stopPropagation(); itemMenu(x, e.currentTarget); } }, icon('more', 14));
      return h('div', {
        class: `ast-item${using ? ' using' : ''}${ui.sel?.has(x.id) ? ' sel' : ''}`, title: tip, 'data-id': x.id,
        onclick: async () => {
          if (ui.sel) {
            if (ui.sel.has(x.id)) ui.sel.delete(x.id);
            else ui.sel.add(x.id);
            return paintGrid();
          }
          if (deps.inUse(x)) deps.unuse(x);
          else await deps.use([x]);
          paintGrid();
        },
      }, h('div', { class: 'ast-img' }, img, using ? h('span', { class: 'ast-badge' }, '使用中') : null),
      h('div', { class: 'ast-name' }, label(x), h('small', {}, sub)),
      h('span', { class: 'chk' }, icon('check', 13)), ui.sel ? null : more);
    });
    const empty = !list.length ? h('div', { class: 'lib-empty' }, st.items.some((x) => x.kind === ui.kind)
      ? '没有匹配的素材'
      : `还没有${KIND_LABEL[ui.kind]}素材。点「导入」上传图片或官网导出的氛围文件，或在左边参考图卡片上点「存入素材库」。`) : null;
    ui.grid.replaceChildren(...[empty, ...tiles].filter(Boolean));
  }

  function paintBatch(list) {
    ui.batch.hidden = !ui.sel;
    if (!ui.sel) return ui.batch.replaceChildren();
    const ids = list.map((x) => x.id);
    const chosen = () => st.items.filter((x) => ui.sel.has(x.id));
    const n = ui.sel.size;
    const all = n > 0 && ids.every((id) => ui.sel.has(id));
    ui.batch.replaceChildren(
      h('span', {}, `已选 ${n}`),
      h('button', { type: 'button', class: 'text-btn', onclick: () => { ui.sel = all ? new Set() : new Set(ids); paintGrid(); } }, all ? '全不选' : '全选'),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !n, onclick: async () => { await deps.use(chosen()); paintGrid(); } }, icon('check', 14), '用于生图'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !n, onclick: (e) => pickCategory(e.currentTarget, ui.kind, (c) => move([...ui.sel], c)) }, icon('folder', 14), '分类'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !n, onclick: () => exportItems(chosen()) }, icon('download', 14), '导出'),
      h('button', { type: 'button', class: 'btn small ghost danger', disabled: !n, onclick: () => remove([...ui.sel]) }, icon('trash', 14), '删除'));
  }

  function itemMenu(x, anchor) {
    const using = deps.inUse(x);
    deps.openMenu(anchor, [
      { label: using ? '不用了（从当前生图移除）' : '用于当前生图', run: async () => { if (using) deps.unuse(x); else await deps.use([x]); paintGrid(); } },
      { label: '改名…', run: () => rename(x) },
      { label: '移到分类…', run: () => pickCategory(anchor, x.kind, (c) => move([x.id], c), x.category) },
      { label: '导出', hint: x.kind === 'vibe' ? '.naiv4vibe' : '.json', run: () => exportItems([x]) },
      { label: '删除', run: () => remove([x.id]) },
    ]);
  }

  return {
    load, reset, open, add, putEncoding, getEncoding, updateParams, item: byId,
    isOpen: () => !!ui.close, refresh: () => paintGrid(),
  };
}
