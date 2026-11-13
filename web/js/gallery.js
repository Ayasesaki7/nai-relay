// 云端图库：收藏的图片存在服务器上（每个中转 key 一份），换电脑、手机也能看到
import { h, icon } from './util.js';

const PAGE = 200;
const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

async function sha256(blob) {
  if (!crypto?.subtle) return null; // 非 HTTPS 下没有，退化为不判断是否已收藏
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * deps: api, toast, openModal, confirmDialog, openMenu, makeThumb,
 *       showRecords(recs)       在主查看器里显示
 *       restoreParams(rec)      弹出「取回参数」对话框
 *       downloadMany(recs)      打包下载
 *       onChange()              收藏状态变了（刷新查看器上的星标）
 */
export function createGallery(deps) {
  const st = { state: 'idle', albums: [], items: [], used: 0, quota: 0, gen: 0, loading: null };
  const shaOf = new WeakMap(); // rec → Promise<sha>
  const thumbs = new Map(); // item id → { url, blob }
  const queue = [];
  let active = 0;
  const ui = { close: null, album: 'all', q: '', sel: null, limit: PAGE, grid: null, obs: null };
  const { api, toast } = deps;

  const bySha = (sha) => (sha ? st.items.find((x) => x.sha === sha) : null);
  const byId = (id) => st.items.find((x) => x.id === id);
  const albumName = (id) => (id ? st.albums.find((a) => a.id === id)?.name || '未分组' : '未分组');

  function apply(summary) {
    if (!summary) return;
    if ('used' in summary) st.used = summary.used;
    if ('quota' in summary) st.quota = summary.quota;
  }

  async function load(force = false) {
    if (st.state === 'ready' && !force) return true;
    if (st.loading) return st.loading;
    const gen = st.gen;
    st.state = st.state === 'ready' ? 'ready' : 'loading';
    st.loading = api.galleryList().then((d) => {
      if (gen !== st.gen) return false;
      Object.assign(st, { state: 'ready', albums: d.albums, items: d.items });
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
      deps.onChange();
    });
    paint();
    return st.loading;
  }

  function reset() {
    st.gen++;
    ui.close?.();
    Object.assign(st, { state: 'idle', albums: [], items: [], used: 0, quota: 0, loading: null });
    for (const t of thumbs.values()) URL.revokeObjectURL(t.url);
    thumbs.clear();
    queue.length = 0;
    Object.assign(ui, { album: 'all', q: '', sel: null, limit: PAGE });
  }

  function hashOf(rec) {
    if (!shaOf.has(rec)) shaOf.set(rec, sha256(rec.blob).catch(() => null));
    return shaOf.get(rec);
  }

  /** 这张图是否已经在图库里；返回图库条目或 null */
  async function savedItem(rec) {
    if (!rec) return null;
    if (rec.gallery) return byId(rec.gallery) || null;
    if (st.state !== 'ready') return null;
    return bySha(await hashOf(rec));
  }

  // ---------- 收藏 ----------

  async function upload(rec, album) {
    const sha = await hashOf(rec);
    const have = bySha(sha);
    if (have) return { item: have, existed: true };
    const thumb = rec.thumb || (await deps.makeThumb(rec.blob)).thumb;
    const meta = { width: rec.width, height: rec.height, tool: rec.tool || '', params: rec.params || null, created: rec.created || Date.now(), album };
    const gen = st.gen;
    const r = await api.galleryAdd(meta, thumb, rec.blob);
    if (gen !== st.gen) throw new Error('已切换用户');
    apply(r);
    if (!r.existed) st.items.unshift(r.item);
    return r;
  }

  async function saveRecords(recs, album = '') {
    if (!recs.length) return;
    if (!(await load())) return toast(`云端图库载入失败：${st.error || ''}`, 'error');
    let added = 0;
    let had = 0;
    for (const [i, rec] of recs.entries()) {
      if (recs.length > 2) toast(`正在收藏 ${i + 1} / ${recs.length}`, 'info', 1200);
      try {
        const r = await upload(rec, album);
        if (r.existed) had++;
        else added++;
      } catch (e) {
        toast(`收藏失败：${e.message}`, 'error', 6000);
        break;
      }
    }
    const where = `「${albumName(album)}」`;
    if (added) toast(`已收藏 ${added} 张到${where}${had ? `，${had} 张之前已收藏` : ''}`, 'ok');
    else if (had) toast(recs.length > 1 ? `这 ${had} 张都已经在图库里了` : '这张图已经在图库里了', 'info');
    paint();
    deps.onChange();
  }

  async function newAlbum() {
    const name = prompt('新相册名称')?.trim();
    if (!name) return null;
    try {
      const r = await api.galleryAlbum('create', null, name);
      st.albums = r.albums;
      paint();
      return r.album.id;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    }
  }

  /** 选一个相册（含「未分组」和「新建相册…」），选完调用 done(id) */
  function pickAlbum(anchor, done, current) {
    const mark = (id) => (current === id ? '当前' : '');
    deps.openMenu(anchor, [
      { label: '未分组', hint: mark(''), run: () => done('') },
      ...st.albums.map((a) => ({ label: a.name, hint: mark(a.id), run: () => done(a.id) })),
      { label: '新建相册…', run: async () => { const id = await newAlbum(); if (id) done(id); } },
    ]);
  }

  /** 收藏几张图：有相册时先选相册，没有就直接存到「未分组」 */
  async function saveWithPicker(recs, anchor) {
    if (!recs.length) return;
    if (!(await load())) return toast(`云端图库载入失败：${st.error || ''}`, 'error');
    if (!st.albums.length) return saveRecords(recs, '');
    pickAlbum(anchor, (id) => saveRecords(recs, id));
  }

  /** 查看器上的「收藏」按钮 */
  async function starMenu(rec, anchor) {
    if (!(await load())) return toast(`云端图库载入失败：${st.error || ''}`, 'error');
    const have = await savedItem(rec);
    if (!have) return saveWithPicker([rec], anchor);
    deps.openMenu(anchor, [
      { label: '在云端图库里查看', run: () => open(have.album || '') },
      { label: '移到其他相册…', run: () => pickAlbum(anchor, (id) => move([have.id], id), have.album) },
      { label: '从云端图库删除', run: () => remove([have.id]) },
    ]);
  }

  // ---------- 整理 ----------

  async function move(ids, album) {
    try {
      apply(await api.galleryBatch('move', ids, album));
      for (const id of ids) {
        const x = byId(id);
        if (x) x.album = album;
      }
      toast(`已移到「${albumName(album)}」`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
  }

  async function remove(ids) {
    if (!ids.length || !(await deps.confirmDialog(`从云端图库删除 ${ids.length} 张图片？服务器上的文件会一起删掉，不能恢复。`, '删除'))) return;
    try {
      apply(await api.galleryBatch('delete', ids));
      const gone = new Set(ids);
      st.items = st.items.filter((x) => !gone.has(x.id));
      for (const id of ids) {
        const t = thumbs.get(id);
        if (t) URL.revokeObjectURL(t.url);
        thumbs.delete(id);
        ui.sel?.delete(id);
      }
      toast(`已删除 ${ids.length} 张`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
    deps.onChange();
  }

  async function renameAlbum(a) {
    const name = prompt('相册改名', a.name)?.trim();
    if (!name || name === a.name) return;
    try {
      st.albums = (await api.galleryAlbum('rename', a.id, name)).albums;
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
  }

  async function deleteAlbum(a) {
    const n = st.items.filter((x) => x.album === a.id).length;
    if (!(await deps.confirmDialog(`删除相册「${a.name}」？里面的 ${n} 张图不会删除，会回到「未分组」。`, '删除相册'))) return;
    try {
      st.albums = (await api.galleryAlbum('delete', a.id)).albums;
      for (const x of st.items) if (x.album === a.id) x.album = '';
      ui.album = 'all';
    } catch (e) {
      toast(e.message, 'error');
    }
    paint();
  }

  // ---------- 取图 ----------

  async function toRecord(item) {
    const gen = st.gen;
    const blob = await api.galleryFile(item.id, false);
    if (gen !== st.gen) throw new Error('已切换用户');
    let thumb = thumbs.get(item.id)?.blob;
    if (!thumb) thumb = await api.galleryFile(item.id, true).catch(() => null);
    const rec = {
      id: `g-${item.id}`, gallery: item.id, blob, thumb: thumb || undefined, width: item.width, height: item.height,
      params: item.params || null, tool: item.tool || null, created: item.created, kind: 'gallery',
    };
    shaOf.set(rec, Promise.resolve(item.sha));
    return rec;
  }

  async function withRecords(items, fn) {
    const slow = setTimeout(() => toast(items.length > 1 ? `正在从服务器取 ${items.length} 张图…` : '正在从服务器取图…', 'info', 2000), 400);
    try {
      const recs = [];
      for (const it of items) recs.push(await toRecord(it));
      await fn(recs);
    } catch (e) {
      toast(`取图失败：${e.message}`, 'error');
    } finally {
      clearTimeout(slow);
    }
  }

  const openItem = (item) => withRecords([item], (recs) => { ui.close?.(); deps.showRecords(recs); });
  const restoreItem = (item) => withRecords([item], (recs) => { ui.close?.(); deps.showRecords(recs); deps.restoreParams(recs[0]); });
  const downloadItems = (items) => withRecords(items, (recs) => deps.downloadMany(recs));

  function loadThumb(item, img) {
    const t = thumbs.get(item.id);
    if (t) {
      img.src = t.url;
      return;
    }
    queue.push([item, img]);
    pump();
  }

  function pump() {
    while (active < 6 && queue.length) {
      const [item, img] = queue.shift();
      if (!img.isConnected) continue;
      const gen = st.gen;
      active++;
      api.galleryFile(item.id, true)
        .then((blob) => {
          if (gen !== st.gen) return;
          let t = thumbs.get(item.id);
          if (!t) thumbs.set(item.id, (t = { url: URL.createObjectURL(blob), blob }));
          img.src = t.url;
        })
        .catch(() => img.classList.add('broken'))
        .finally(() => { active--; pump(); });
    }
  }

  // ---------- 界面 ----------

  function open(album) {
    if (album !== undefined) ui.album = album;
    ui.limit = PAGE;
    if (!ui.close) {
      ui.root = h('div', { class: 'gal' });
      const opts = {
        title: '云端图库',
        wide: true,
        cls: 'lib-modal gal-modal',
        body: ui.root,
        onClose: () => { ui.close = null; ui.sel = null; ui.obs?.disconnect(); },
      };
      ui.close = deps.openPage?.(opts) || deps.openModal(opts);
    }
    load(true);
    paint();
  }

  function matches(x, q) {
    if (!q) return true;
    const p = x.params || {};
    const text = [p.prompt, p.negative, ...(p.characters || []).map((c) => c.prompt), x.tool, p.seed].filter(Boolean).join('\n').toLowerCase();
    return q.split(/\s+/).every((w) => text.includes(w));
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
    if (ui.album !== 'all' && ui.album !== '' && !st.albums.some((a) => a.id === ui.album)) ui.album = 'all';

    const pct = st.quota ? Math.min(100, (st.used / st.quota) * 100) : 0;
    const usage = h('div', { class: 'gal-usage' },
      h('span', {}, `${st.items.length} 张 · 已用 ${fmtSize(st.used)} / ${fmtSize(st.quota)}`),
      h('div', { class: `gal-meter${pct > 90 ? ' full' : ''}` }, h('i', { style: { width: `${pct}%` } })));

    const search = h('input', { type: 'search', class: 'gal-search', placeholder: '按提示词、种子搜索…', value: ui.q, spellcheck: 'false' });
    search.addEventListener('input', () => { ui.q = search.value; ui.limit = PAGE; paintGrid(); });
    const tools = h('div', { class: 'lib-tools' }, search,
      h('button', { type: 'button', class: `btn small ghost${ui.sel ? ' on' : ''}`, onclick: () => { ui.sel = ui.sel ? null : new Set(); paint(); } }, ui.sel ? '完成' : '批量'));

    const count = (id) => st.items.filter((x) => (id === 'all' ? true : x.album === id || (id === '' && !st.albums.some((a) => a.id === x.album)))).length;
    const chip = (id, label) => h('button', {
      type: 'button', class: `chip small${ui.album === id ? ' on' : ''}`, 'data-album': id,
      onclick: () => { ui.album = id; ui.limit = PAGE; ui.sel &&= new Set(); paint(); },
    }, label, h('small', {}, count(id)));
    const albums = h('div', { class: 'lib-cats' },
      chip('all', '全部'), chip('', '未分组'), ...st.albums.map((a) => chip(a.id, a.name)),
      h('button', { type: 'button', class: 'chip small dashed', title: '新建相册', onclick: async () => { const id = await newAlbum(); if (id) { ui.album = id; paint(); } } }, icon('plus', 12)));
    const curAlbum = st.albums.find((a) => a.id === ui.album);
    const albumBar = curAlbum ? h('div', { class: 'lib-catbar' },
      h('span', { class: 'faint' }, `相册「${curAlbum.name}」`),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => renameAlbum(curAlbum) }, '改名'),
      h('button', { type: 'button', class: 'btn small ghost danger', onclick: () => deleteAlbum(curAlbum) }, '删除相册')) : null;

    ui.grid = h('div', { class: 'gal-grid' });
    ui.batch = h('div', { class: 'gal-batch' });
    root.replaceChildren(...[usage, tools, albums, albumBar, ui.batch, ui.grid].filter(Boolean));
    paintGrid();
    if (focused) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  function visible() {
    const q = ui.q.trim().toLowerCase();
    return st.items.filter((x) => (ui.album === 'all' || x.album === ui.album || (ui.album === '' && !st.albums.some((a) => a.id === x.album))) && matches(x, q));
  }

  function paintGrid() {
    const list = visible();
    paintBatch(list);
    ui.obs?.disconnect();
    ui.obs = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        ui.obs.unobserve(en.target);
        const it = byId(en.target.dataset.id);
        if (it) loadThumb(it, en.target);
      }
    }, { root: ui.grid.closest('.modal-body'), rootMargin: '400px' });
    const tiles = list.slice(0, ui.limit).map((x) => {
      const img = h('img', { alt: '', draggable: 'false', 'data-id': x.id });
      const t = thumbs.get(x.id);
      if (t) img.src = t.url;
      else ui.obs.observe(img);
      const p = x.params;
      const tip = [p?.prompt?.slice(0, 160), `${x.width}×${x.height}`, p?.seed ? `seed ${p.seed}` : ''].filter(Boolean).join('\n');
      const more = h('button', { type: 'button', class: 'gal-more', title: '更多', onclick: (e) => { e.stopPropagation(); itemMenu(x, e.currentTarget); } }, icon('more', 14));
      return h('div', {
        class: `gal-item${ui.sel?.has(x.id) ? ' sel' : ''}`, title: tip, 'data-id': x.id,
        style: { aspectRatio: x.width && x.height ? `${x.width} / ${x.height}` : '2 / 3' },
        onclick: () => {
          if (!ui.sel) return openItem(x);
          if (ui.sel.has(x.id)) ui.sel.delete(x.id);
          else ui.sel.add(x.id);
          paintGrid();
        },
      }, img, x.tool ? h('span', { class: 'tag' }, x.tool) : null,
      ui.album === 'all' && x.album ? h('span', { class: 'gal-album' }, albumName(x.album)) : null,
      h('span', { class: 'chk' }, icon('check', 13)), ui.sel ? null : more);
    });
    const empty = !list.length ? h('div', { class: 'lib-empty' }, st.items.length
      ? '没有匹配的图片'
      : '还没有收藏的图片。在查看器下面点「收藏」，或在历史里多选后点「收藏」，图片就会存到服务器上。') : null;
    const moreBtn = list.length > ui.limit ? h('button', {
      type: 'button', class: 'btn ghost small gal-loadmore', onclick: () => { ui.limit += PAGE; paintGrid(); },
    }, `再显示 ${Math.min(PAGE, list.length - ui.limit)} 张（共 ${list.length}）`) : null;
    ui.grid.replaceChildren(...[empty, ...tiles, moreBtn].filter(Boolean));
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
      h('button', { type: 'button', class: 'btn small ghost', disabled: !n, onclick: (e) => pickAlbum(e.currentTarget, (id) => move([...ui.sel], id)) }, icon('folder', 14), '移到'),
      h('button', { type: 'button', class: 'btn small ghost', disabled: !n, onclick: () => downloadItems(chosen()) }, icon('download', 14), '下载'),
      h('button', { type: 'button', class: 'btn small ghost danger', disabled: !n, onclick: () => remove([...ui.sel]) }, icon('trash', 14), '删除'));
  }

  function itemMenu(x, anchor) {
    deps.openMenu(anchor, [
      { label: '在查看器打开', run: () => openItem(x) },
      x.params ? { label: '取回参数…', hint: '选择要用的部分', run: () => restoreItem(x) } : null,
      { label: '下载原图', run: () => downloadItems([x]) },
      { label: '移到相册…', run: () => pickAlbum(anchor, (id) => move([x.id], id), x.album) },
      { label: '删除', run: () => remove([x.id]) },
    ].filter(Boolean));
  }

  return { load, reset, open, isOpen: () => !!ui.close, saveRecords, saveWithPicker, starMenu, savedItem, pickAlbum, hasAlbums: () => st.albums.length > 0, ready: () => st.state === 'ready' };
}
