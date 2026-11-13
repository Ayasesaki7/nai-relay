// 灵感画廊：从 Danbooru / Safebooru / Gelbooru 找图看 TAG，选中的词加到提示词，原图可以带回生图页
// 列表和图片都由服务器代取（国内多半直连不上）；收藏存在服务器上，每个人各一份

import { h, icon } from './util.js';
import { createDoc } from './library.js';
import { addTo } from './prompt.js';
import { CJK, toPrompt } from './tags.js';

const MODES = [['latest', '最新'], ['popular', '热门'], ['random', '随机'], ['score', '高分']];
const SCALES = [['day', '日'], ['week', '周'], ['month', '月']];
const RATINGS = [['g', '全年龄'], ['s', '轻微'], ['q', '较露骨'], ['e', '限制级']];
const GROUPS = [['artist', '画师'], ['character', '角色'], ['copyright', '作品'], ['general', '一般'], ['meta', '元数据']];
const PICKED_BY_DEFAULT = new Set(['character', 'copyright', 'general']);
const FAV_MAX = 1000;
const FAV_KEYS = ['src', 'id', 'w', 'h', 'ext', 'preview', 'sample', 'file', 'rating', 'score', 'tags', 'source', 'post'];
const favKey = (x) => `${x.src}:${x.id}`;

/**
 * deps: api, getKey, toast, openModal, saveBlob,
 *   targets(): [{ id, label, ta }]，initialTarget()，editPrompt(ta, value)
 *   importBlob(blob): 交给生图页的「读取图片参数」对话框
 */
export function createBooru(deps) {
  const { api, toast } = deps;
  const favs = createDoc({
    api,
    kind: 'booru',
    normalize: (d) => ({ items: Array.isArray(d?.items) ? d.items.filter((x) => x && x.src && x.id && x.preview).slice(0, FAV_MAX) : [] }),
    onChange: () => { if (ui.close && ui.src === 'fav' && !ui.detail) paint(); else paintFavBtn(); },
    onError: (m) => toast(m, 'error'),
  });
  const ui = {
    close: null, body: null, src: 'danbooru', mode: 'latest', scale: 'day', ratings: new Set(['g', 's']),
    input: '', query: '', page: 1, items: [], more: false, loading: false, err: '', gen: 0,
    sources: null, detail: null, target: null, obs: null,
  };
  addEventListener('pagehide', () => { const k = deps.getKey(); if (k) favs.beacon(k); });
  const blobs = new Map(); // 图片地址 → object URL（关掉窗口时统一释放）
  const queue = [];
  let active = 0;

  // ---------- 取图 ----------

  function fetchImage(url) {
    const hit = blobs.get(url);
    if (hit) return Promise.resolve(hit);
    return api.booruImage(url).then((b) => {
      const u = URL.createObjectURL(b);
      blobs.set(url, u);
      return u;
    });
  }

  function loadInto(img, url) {
    const hit = blobs.get(url);
    if (hit) {
      img.src = hit;
      return;
    }
    queue.push([img, url]);
    pump();
  }

  function pump() {
    while (active < 6 && queue.length) {
      const [img, url] = queue.shift();
      if (!img.isConnected) continue;
      active++;
      fetchImage(url)
        .then((u) => { if (img.isConnected) img.src = u; })
        .catch(() => img.classList.add('broken'))
        .finally(() => { active--; pump(); });
    }
  }

  function releaseAll() {
    queue.length = 0;
    for (const u of blobs.values()) URL.revokeObjectURL(u);
    blobs.clear();
  }

  // ---------- 搜索 ----------

  /** 输入框 → 图片站的 TAG：有逗号按逗号分（词里的空格换成下划线），否则按空格分；中文查词典换成英文 */
  async function toQuery(text) {
    const raw = /[,，]/.test(text) ? text.split(/[,，]/).map((s) => s.trim().replace(/\s+/g, '_')) : text.split(/\s+/);
    const out = [];
    const miss = [];
    for (const w of raw.map((s) => s.trim()).filter(Boolean)) {
      if (!CJK.test(w)) {
        out.push(w.toLowerCase());
        continue;
      }
      try {
        const r = await api.tagSearch(w, null, 1);
        const name = r.items?.[0]?.name;
        if (name) out.push(name);
        else miss.push(w);
      } catch {
        miss.push(w);
      }
    }
    if (miss.length) toast(`词典里没找到：${miss.join('、')}`, 'error');
    return out.join(' ');
  }

  async function search(reset = true) {
    if (ui.src === 'fav') {
      ui.query = ui.input.trim().toLowerCase();
      ui.toTop = true;
      paint();
      return;
    }
    const gen = ++ui.gen;
    if (reset) {
      ui.query = await toQuery(ui.input);
      if (gen !== ui.gen) return;
      ui.page = 1;
      ui.items = [];
      ui.more = false;
    }
    ui.loading = true;
    ui.err = '';
    paint();
    if (reset) ui.toTop = true;
    try {
      const r = await api.booruPosts({
        src: ui.src, tags: ui.query, page: ui.page, mode: ui.mode, scale: ui.scale,
        rating: RATINGS.map((x) => x[0]).filter((x) => ui.ratings.has(x)).join(','),
      });
      if (gen !== ui.gen) return;
      const seen = new Set(ui.items.map(favKey));
      ui.items.push(...r.items.filter((x) => !seen.has(favKey(x))));
      ui.more = r.more;
      ui.page += 1;
    } catch (e) {
      if (gen !== ui.gen) return;
      ui.err = e.message;
    }
    ui.loading = false;
    paint();
  }

  // ---------- 收藏 ----------

  const isFav = (x) => favs.data.items.some((f) => favKey(f) === favKey(x));

  function toggleFav(x) {
    const on = isFav(x);
    if (!on && favs.data.items.length >= FAV_MAX) {
      toast(`收藏最多 ${FAV_MAX} 张，先删掉一些`, 'error');
      return;
    }
    const k = favKey(x);
    const rec = Object.fromEntries(FAV_KEYS.map((key) => [key, x[key]]));
    const ok = favs.mutate((d) => {
      d.items = d.items.filter((f) => favKey(f) !== k);
      if (!on) d.items.unshift({ ...rec, t: Date.now() });
    });
    if (ok) toast(on ? '已取消收藏' : '已收藏', on ? '' : 'ok');
  }

  function paintFavBtn() {
    const b = ui.body?.querySelector('[data-fav]');
    if (!b || !ui.detail) return;
    const on = isFav(ui.detail);
    b.classList.toggle('on', on);
    b.lastChild.textContent = on ? '已收藏' : '收藏';
  }

  // ---------- 窗口 ----------

  function list() {
    if (ui.src !== 'fav') return ui.items;
    const words = ui.query.split(/[\s,，]+/).filter(Boolean).map((w) => w.replace(/\s+/g, '_'));
    return favs.data.items.filter((x) => {
      if (!ui.ratings.has(x.rating)) return false;
      const all = Object.values(x.tags || {}).flat();
      return words.every((w) => all.some((t) => t.includes(w)));
    });
  }

  async function open() {
    if (ui.close) return;
    ui.body = h('div', { class: 'gal bru' });
    const opts = {
      title: '灵感画廊',
      cls: 'gal-modal bru-modal',
      body: ui.body,
      onClose: () => {
        ui.close = null;
        ui.detail = null;
        ui.gen++;
        ui.obs?.disconnect();
        releaseAll();
      },
    };
    ui.close = deps.openPage?.(opts) || deps.openModal(opts);
    if (favs.state === 'idle' || favs.state === 'error') favs.load();
    paint();
    if (!ui.sources) {
      try {
        ui.sources = (await api.booruSources()).items;
      } catch (e) {
        ui.err = e.message;
      }
    }
    if (ui.close && !ui.items.length && ui.src !== 'fav') search();
    else paint();
  }

  function paint() {
    if (!ui.close) return;
    if (ui.detail) paintDetail();
    else paintGrid();
  }

  function seg(options, value, onPick, cls = '') {
    return h('div', { class: `seg ${cls}` }, options.map(([id, label, extra]) =>
      h('button', { type: 'button', class: id === value ? 'on' : '', 'data-v': id, title: extra || null, onclick: () => onPick(id) }, label)));
  }

  function paintGrid() {
    const srcs = (ui.sources || [{ id: 'danbooru', name: 'Danbooru', modes: MODES.map((m) => m[0]), ready: true }])
      .filter((s) => s.ready)
      .map((s) => [s.id, s.name]);
    srcs.push(['fav', '★ 收藏']);
    const src = ui.sources?.find((s) => s.id === ui.src);
    const modes = MODES.filter(([id]) => !src || src.modes.includes(id));
    if (src && !src.modes.includes(ui.mode)) ui.mode = 'latest';
    const input = h('input', {
      type: 'search', value: ui.input, class: 'bru-q',
      placeholder: ui.src === 'fav' ? '在收藏里按 TAG 筛选' : '搜 TAG，中文会自动换成英文，如：初音未来 笑',
      oninput: (e) => { ui.input = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') search(); },
    });
    const head = h('div', { class: 'bru-head' },
      seg(srcs, ui.src, (id) => { ui.src = id; ui.input = ''; ui.query = ''; ui.items = []; ui.err = ''; search(); }, 'bru-src'),
      ui.src === 'fav' ? null : seg(modes, ui.mode, (id) => { ui.mode = id; search(); }, 'bru-mode'),
      ui.src !== 'fav' && ui.mode === 'popular' ? seg(SCALES, ui.scale, (id) => { ui.scale = id; search(); }, 'bru-scale') : null);
    const tools = h('div', { class: 'lib-tools' }, input,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => search() }, icon('search', 14), '搜索'));
    const ratings = h('div', { class: 'lib-cats bru-ratings' }, h('span', { class: 'faint' }, '分级：'),
      RATINGS.map(([id, label]) => {
        if (src?.safe && (id === 'q' || id === 'e')) return null;
        return h('button', {
          type: 'button', class: `chip small${ui.ratings.has(id) ? ' on' : ''}`, 'data-r': id,
          onclick: () => {
            if (ui.ratings.has(id) && ui.ratings.size === 1) return;
            if (ui.ratings.has(id)) ui.ratings.delete(id);
            else ui.ratings.add(id);
            search();
          },
        }, label);
      }),
      ui.src !== 'fav' && ui.query ? h('span', { class: 'faint mono bru-actual' }, `实际搜索：${ui.query}`) : null,
      ui.src === 'danbooru' ? h('span', { class: 'faint bru-hint' }, 'Danbooru 最多 2 个 TAG，「随机」「高分」「热门」也各占一个') : null);

    const items = list();
    ui.obs?.disconnect();
    ui.obs = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        ui.obs.unobserve(en.target);
        loadInto(en.target, en.target.dataset.u);
      }
    }, { root: ui.body.closest('.modal-body'), rootMargin: '500px' });
    const grid = h('div', { class: 'gal-grid bru-grid' }, items.map((x, i) => {
      const img = h('img', { alt: '', draggable: 'false', 'data-u': x.preview, style: { aspectRatio: x.w && x.h ? `${x.w} / ${x.h}` : null } });
      ui.obs.observe(img);
      const tip = [...(x.tags.character || []), ...(x.tags.copyright || []), ...(x.tags.artist || []).map((a) => `by ${a}`)].slice(0, 6).join('  ');
      return h('div', { class: 'gal-item bru-item', title: tip || null, 'data-i': i, onclick: () => showDetail(items, i) },
        img,
        h('span', { class: 'tag' }, `${x.w}×${x.h}`),
        isFav(x) ? h('span', { class: 'bru-star' }, icon('star', 12)) : null);
    }));
    if (!items.length) {
      const msg = ui.loading ? '载入中…' : ui.err ? '' : ui.src === 'fav'
        ? (favs.state === 'loading' ? '载入中…' : favs.state === 'error' ? `载入失败：${favs.failed}` : '还没有收藏。看到喜欢的图点「收藏」就会出现在这里')
        : '没有找到图片，换个 TAG 试试';
      if (msg) grid.append(h('div', { class: 'lib-empty' }, msg));
    }
    if (ui.err) grid.append(h('div', { class: 'lib-empty bad' }, ui.err));
    if (ui.src !== 'fav' && items.length && (ui.more || ui.loading)) {
      grid.append(h('button', { class: 'btn ghost small gal-loadmore', type: 'button', disabled: ui.loading, onclick: () => search(false) },
        ui.loading ? '载入中…' : '加载更多'));
    }
    const scroller = ui.body.closest('.modal-body');
    const keep = scroller && !ui.toTop ? scroller.scrollTop : 0;
    ui.toTop = false;
    ui.body.replaceChildren(head, tools, ratings, grid);
    if (scroller) scroller.scrollTop = keep;
    if (document.activeElement === document.body) input.focus({ preventScroll: true });
  }

  // ---------- 详情 ----------

  function showDetail(items, i) {
    ui.detail = items[i];
    ui.detailList = items;
    ui.detailIndex = i;
    ui.picked = null;
    ui.scrollBack = ui.body.closest('.modal-body')?.scrollTop || 0;
    paint();
  }

  function back() {
    ui.detail = null;
    paint();
    const sc = ui.body.closest('.modal-body');
    if (sc) sc.scrollTop = ui.scrollBack || 0;
  }

  // 详情页：左右方向键翻图，退格回列表
  addEventListener('keydown', (e) => {
    if (!ui.close || !ui.detail || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (document.querySelectorAll('.overlay:not(#login)').length > 1) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Backspace') back();
    else return;
    e.preventDefault();
  });

  function step(d) {
    const n = ui.detailIndex + d;
    if (n < 0 || n >= ui.detailList.length) return;
    showDetail(ui.detailList, n);
  }

  const promptOf = (group, name) => (group === 'artist' ? `artist:${toPrompt(name)}` : toPrompt(name));

  function paintDetail() {
    const x = ui.detail;
    if (!ui.picked) {
      ui.picked = new Set();
      for (const [g] of GROUPS) if (PICKED_BY_DEFAULT.has(g)) for (const t of x.tags[g] || []) ui.picked.add(`${g}\n${t}`);
    }
    const img = h('img', { class: 'bru-img', alt: '', draggable: 'false' });
    const thumb = blobs.get(x.preview);
    if (thumb) img.src = thumb;
    fetchImage(x.sample).then((u) => { if (img.isConnected) img.src = u; }).catch(() => { if (!thumb) img.classList.add('broken'); });
    const targets = deps.targets();
    if (!targets.some((t) => t.id === ui.target)) ui.target = deps.initialTarget?.() || targets[0]?.id;
    const chips = [];
    const groups = GROUPS.map(([g, label]) => {
      const names = x.tags[g] || [];
      if (!names.length) return null;
      return h('div', { class: 'bru-group' }, h('div', { class: 'bru-group-head' }, h('b', {}, label),
        h('button', {
          type: 'button', class: 'text-btn',
          onclick: () => {
            const all = names.every((t) => ui.picked.has(`${g}\n${t}`));
            for (const t of names) { if (all) ui.picked.delete(`${g}\n${t}`); else ui.picked.add(`${g}\n${t}`); }
            paintPicked();
          },
        }, '全选/全不选')),
      h('div', { class: 'bru-tags' }, names.map((t) => {
        const key = `${g}\n${t}`;
        const chip = h('button', {
          type: 'button', class: `chip small bru-tag c-${g}`, 'data-key': key, title: '点一下选中/取消；右键用这个 TAG 搜索',
          onclick: () => { if (ui.picked.has(key)) ui.picked.delete(key); else ui.picked.add(key); paintPicked(); },
          oncontextmenu: (e) => { e.preventDefault(); searchTag(t); },
        }, h('span', {}, t.replace(/_/g, ' ')), h('small', { 'data-cn': t }));
        chips.push(chip);
        return chip;
      })));
    });
    const count = h('span', { class: 'faint' });
    function paintPicked() {
      for (const c of chips) c.classList.toggle('on', ui.picked.has(c.dataset.key));
      count.textContent = `已选 ${ui.picked.size} 个`;
    }
    const pickedText = () => GROUPS.flatMap(([g]) => (x.tags[g] || []).filter((t) => ui.picked.has(`${g}\n${t}`)).map((t) => promptOf(g, t))).join(', ');
    const sel = h('select', { class: 'mini-select bru-target', onchange: (e) => { ui.target = e.target.value; } },
      targets.map((t) => h('option', { value: t.id, selected: t.id === ui.target }, t.label)));
    const addBtn = h('button', {
      class: 'btn primary small', type: 'button',
      onclick: () => {
        const text = pickedText();
        const t = deps.targets().find((tt) => tt.id === ui.target);
        if (!text || !t) return toast(text ? '找不到要加到的输入框' : '先选几个 TAG', 'error');
        deps.editPrompt(t.ta, addTo(t.ta.value, text));
        toast(`已加到「${t.label}」`, 'ok');
      },
    }, '加到提示词');
    const copyBtn = h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: async () => {
        const text = pickedText();
        if (!text) return toast('先选几个 TAG', 'error');
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制', 'ok');
        } catch {
          toast('复制失败，浏览器不让访问剪贴板', 'error');
        }
      },
    }, icon('copy', 14), '复制');
    const searchBtn = h('button', {
      class: 'btn ghost small', type: 'button', title: '用选中的 TAG 搜索（Danbooru 只取前 2 个）',
      onclick: () => {
        const names = GROUPS.flatMap(([g]) => (x.tags[g] || []).filter((t) => ui.picked.has(`${g}\n${t}`)));
        if (names.length) searchTag(names.slice(0, ui.src === 'danbooru' || x.src === 'danbooru' ? 2 : 6).join(' '));
      },
    }, icon('search', 14), '搜选中的');

    const fav = h('button', { class: 'btn ghost small', type: 'button', 'data-fav': '', onclick: () => toggleFav(x) }, icon('star', 14), h('span', {}, ''));
    const busy = (btn, fn) => async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const old = btn.lastChild.textContent;
      btn.lastChild.textContent = '下载原图中…';
      try {
        await fn(await api.booruImage(x.file));
      } catch (e) {
        toast(`原图取不到：${e.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.lastChild.textContent = old;
      }
    };
    const useBtn = h('button', { class: 'btn ghost small', type: 'button', title: '读取图里的生成参数（如果有），或者当作底图、角色参考、氛围参考' }, icon('image', 14), h('span', {}, '带回生图 / 读取生成信息'));
    useBtn.onclick = busy(useBtn, (blob) => { ui.close?.(); deps.importBlob(blob); });
    const dlBtn = h('button', { class: 'btn ghost small', type: 'button' }, icon('download', 14), h('span', {}, '下载原图'));
    dlBtn.onclick = busy(dlBtn, (blob) => deps.saveBlob(blob, `${x.src}_${x.id}.${x.ext === 'jpeg' ? 'jpg' : x.ext}`));
    const site = (ui.sources?.find((s) => s.id === x.src)?.name) || x.src;
    const ratingLabel = RATINGS.find((r) => r[0] === x.rating)?.[1] || x.rating;
    const info = h('div', { class: 'bru-facts faint mono' }, [`${site} #${x.id}`, `${x.w}×${x.h}`, `${ratingLabel}`, `${x.score} 分`].join(' · '));
    const links = h('div', { class: 'bru-links' },
      h('a', { href: x.post, target: '_blank', rel: 'noopener noreferrer' }, '原帖'),
      /^https?:\/\//.test(x.source || '') ? h('a', { href: x.source, target: '_blank', rel: 'noopener noreferrer', title: x.source }, '出处') : null,
      x.source && !/^https?:\/\//.test(x.source) ? h('span', { class: 'faint' }, `出处：${x.source}`) : null);
    const nav = h('div', { class: 'bru-nav' },
      h('button', { class: 'btn ghost small', type: 'button', onclick: back }, '‹ 返回列表'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost small', type: 'button', disabled: ui.detailIndex <= 0, onclick: () => step(-1) }, '上一张'),
      h('button', { class: 'btn ghost small', type: 'button', disabled: ui.detailIndex >= ui.detailList.length - 1, onclick: () => step(1) }, '下一张'));
    ui.body.replaceChildren(nav, h('div', { class: 'bru-detail' },
      h('div', { class: 'bru-left' }, img, info, links, h('div', { class: 'bru-acts' }, fav, useBtn, dlBtn)),
      h('div', { class: 'bru-right' }, groups,
        h('div', { class: 'bru-add' }, count, h('span', { class: 'grow' }), searchBtn, copyBtn, h('span', { class: 'faint' }, '加到'), sel, addBtn))));
    const sc = ui.body.closest('.modal-body');
    if (sc) sc.scrollTop = 0;
    paintPicked();
    paintFavBtn();
    fillChinese(x);
  }

  async function fillChinese(x) {
    const names = Object.values(x.tags).flat().slice(0, 300);
    if (!names.length) return;
    try {
      const r = await api.tagLookup(names);
      if (ui.detail !== x) return;
      for (const el of ui.body.querySelectorAll('[data-cn]')) {
        const cn = r.items?.[el.dataset.cn.toLowerCase()]?.cn;
        if (cn) el.textContent = cn.split(/[,，]/)[0];
      }
    } catch {}
  }

  function searchTag(tags) {
    if (ui.src === 'fav') ui.src = ui.detail?.src || 'danbooru';
    ui.detail = null;
    ui.input = tags;
    if (ui.mode === 'popular') ui.mode = 'latest';
    search();
  }

  return {
    open,
    isOpen: () => !!ui.close,
    reset: () => {
      ui.close?.();
      favs.reset();
      Object.assign(ui, { items: [], input: '', query: '', page: 1, more: false, err: '', sources: null, detail: null, src: 'danbooru' });
    },
  };
}
