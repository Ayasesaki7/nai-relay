// TAG 检索面板：中英词库搜索、TAG 详情（别名 / 相关 TAG）、一键加到提示词
import { $, h, icon, debounce } from './util.js';

export const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const CATS = [[null, '全部'], [0, '常规'], [4, '角色'], [3, '作品'], [1, '画师'], [5, '元数据']];
const CAT_NAME = { 0: '常规', 1: '画师', 3: '作品', 4: '角色', 5: '元数据' };

export function fmtCount(n) {
  if (!n) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Danbooru 写法 → 提示词写法。o_o、^_^ 这类颜文字保留下划线 */
export const toPrompt = (name) => (/[a-z]{2,}/i.test(name) ? name.replace(/_/g, ' ') : name);

/** 提示词里的一段 → Danbooru 写法，用来判断某个 TAG 是否已经在提示词里 */
export function tagKey(s) {
  return s.trim().replace(/^\/\/\s*/, '').replace(/^-?[\d.]+::|::$/g, '').replace(/^[{[\s]+|[}\]\s]+$/g, '').toLowerCase().replace(/\s+/g, '_');
}

const hasTag = (text, name) => text.split(/[,\n|]/).some((part) => tagKey(part) === name);

function addTag(ta, name) {
  const v = ta.value.replace(/\s+$/, '');
  ta.value = v ? `${v}${v.endsWith(',') ? ' ' : ', '}${toPrompt(name)}` : toPrompt(name);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function removeTag(ta, name) {
  const parts = ta.value.split(',');
  const keep = parts.filter((p) => tagKey(p) !== name);
  ta.value = keep.map((p, i) => (i ? p.replace(/^\s*/, ' ') : p.trimStart())).join(',').replace(/^,\s*/, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * api: createApi 的返回值；targets(): [{ id, label, ta }]，可以往里加 TAG 的输入框
 * beforeEdit(): 改输入框之前调用（用来跳过一次自动补全）
 */
export function createTagPanel({ api, targets, toast, beforeEdit, initialTarget, favorite }) {
  const cnCache = new Map();
  const st = { q: '', cat: null, items: [], ready: true, error: '', target: 'prompt', stack: [], ctl: null, loading: false };

  const input = h('input', { type: 'search', class: 'tg-input', placeholder: '中文或英文，如 长发 / long hair / 初音', spellcheck: 'false', autocomplete: 'off' });
  const cats = h('div', { class: 'tg-cats' });
  const targetBar = h('div', { class: 'tg-targets' });
  const body = h('div', { class: 'tg-body', tabindex: '-1' });
  const status = h('span', { class: 'tg-status' });
  const panel = h('aside', { class: 'tag-panel', id: 'tag-panel', hidden: true },
    h('div', { class: 'tg-head' },
      h('b', {}, 'TAG 检索'), status,
      h('button', { class: 'icon-btn', type: 'button', title: '关闭（Esc）', onclick: () => close() }, icon('x', 16))),
    h('div', { class: 'tg-search' }, icon('search', 15), input),
    cats, targetBar, body,
    h('div', { class: 'tg-foot' }, '中文词库来自 ffdkj 对照表（机翻 + 人工校对），别名和相关 TAG 来自 Danbooru'));
  document.body.append(panel);

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (st.stack.length) back();
      else close();
    }
  });
  input.addEventListener('input', () => {
    st.q = input.value;
    st.stack = [];
    search();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && st.items[0]) {
      e.preventDefault();
      toggle(st.items[0].name);
    }
  });
  // 提示词改了（手动或别处），刷新 ✓ 标记
  document.addEventListener('input', (e) => {
    if (!panel.hidden && e.target.matches?.('textarea.tag-input')) paintMarks();
  });

  function currentTarget() {
    const list = targets();
    return list.find((t) => t.id === st.target) || list[0];
  }

  function paintTargets() {
    const list = targets();
    if (!list.some((t) => t.id === st.target)) st.target = list[0].id;
    targetBar.replaceChildren(h('span', { class: 'faint' }, '加到'), ...list.map((t) => h('button', {
      type: 'button', class: t.id === st.target ? 'on' : '',
      onclick: () => { st.target = t.id; paintTargets(); paintMarks(); },
    }, t.label)));
  }

  function paintCats() {
    cats.replaceChildren(...CATS.map(([v, label]) => h('button', {
      type: 'button', class: `chip${v === st.cat ? ' on' : ''}`,
      onclick: () => { st.cat = v; paintCats(); st.stack = []; search(); },
    }, label)));
  }

  function toggle(name) {
    const t = currentTarget();
    if (!t?.ta) return;
    beforeEdit?.();
    if (hasTag(t.ta.value, name)) removeTag(t.ta, name);
    else addTag(t.ta, name);
    paintMarks();
  }

  function paintMarks() {
    const text = currentTarget()?.ta?.value || '';
    for (const b of body.querySelectorAll('[data-tag]')) {
      const on = hasTag(text, b.dataset.tag);
      b.classList.toggle('on', on);
      if (b.classList.contains('tg-add')) {
        b.replaceChildren(icon(on ? 'check' : 'plus', 14));
        b.title = on ? `从「${currentTarget().label}」里去掉` : `加到「${currentTarget().label}」`;
      } else {
        b.textContent = on ? `已在「${currentTarget().label}」里，点击去掉` : `加到「${currentTarget().label}」`;
      }
    }
  }

  function row(t) {
    return h('div', { class: 'tg-row', onclick: () => openDetail(t.name) },
      h('i', { class: `tg-dot c${t.cat}`, title: CAT_NAME[t.cat] || '' }),
      h('div', { class: 'tg-names' }, h('span', { class: 'tg-en' }, toPrompt(t.name)), t.cn ? h('span', { class: 'tg-cn' }, t.cn) : null),
      h('span', { class: 'tg-n' }, fmtCount(t.count)),
      h('button', {
        type: 'button', class: 'tg-add', 'data-tag': t.name,
        onclick: (e) => { e.stopPropagation(); toggle(t.name); },
      }));
  }

  function message(text, cls = 'faint') {
    return h('div', { class: `tg-msg ${cls}` }, text);
  }

  function paintList() {
    if (!st.ready) body.replaceChildren(message(st.error || '中文词库还在下载，一两分钟后再试', 'warn-text'));
    else if (!st.q.trim()) {
      body.replaceChildren(message('输入中文或英文查找 TAG。点 ＋ 加到上面选中的提示词，再点一次去掉；点整行看别名和相关 TAG。'));
    } else if (st.loading && !st.items.length) body.replaceChildren(message('搜索中…'));
    else if (!st.items.length) body.replaceChildren(message('没有找到。可以换个说法，或者少打几个字'));
    else body.replaceChildren(...st.items.map(row));
    paintMarks();
  }

  const search = debounce(async () => {
    st.ctl?.abort();
    const q = st.q.trim();
    if (!q) {
      st.items = [];
      paintList();
      return;
    }
    const ctl = (st.ctl = new AbortController());
    st.loading = true;
    try {
      const res = await api.tagSearch(q, st.cat, 60, ctl.signal);
      if (ctl.signal.aborted) return;
      st.ready = res.ready;
      st.error = res.error || '';
      st.items = res.items;
      for (const t of res.items) cnCache.set(t.name, t.cn);
      if (res.count) status.textContent = `${res.count.toLocaleString()} 个词`;
    } catch (e) {
      if (e.name === 'AbortError') return;
      st.items = [];
      toast(`TAG 搜索失败：${e.message}`, 'error');
    } finally {
      if (st.ctl === ctl) st.loading = false;
    }
    if (!st.stack.length) paintList();
  }, 180);

  async function openDetail(name) {
    st.stack.push(name);
    body.replaceChildren(message('加载中…'));
    body.scrollTop = 0;
    // 点过的那一行会被换掉，焦点留在面板里 Esc 才能用
    if (!panel.contains(document.activeElement) || document.activeElement === document.body) body.focus({ preventScroll: true });
    let d;
    try {
      d = await api.tagDetail(name);
    } catch (e) {
      if (st.stack.at(-1) !== name) return;
      body.replaceChildren(backBtn(), message(`加载失败：${e.message}`, 'warn-text'));
      return;
    }
    if (st.stack.at(-1) !== name) return;
    const t = d.tag || { name, cat: 0, cn: '', count: 0 };
    for (const r of d.related) cnCache.set(r.name, r.cn);
    const chipList = (title, names, clickable) => names.length ? h('div', { class: 'tg-sec' },
      h('div', { class: 'tg-sec-title' }, title),
      h('div', { class: 'tg-chips' }, ...names.map((n) => clickable
        ? h('button', { type: 'button', class: 'chip', onclick: () => { input.value = n; st.q = n; st.stack = []; search(); } }, n)
        : h('span', { class: 'chip static' }, n)))) : null;
    body.replaceChildren(
      backBtn(),
      h('div', { class: 'tg-detail' },
        h('div', { class: 'tg-title' }, h('i', { class: `tg-dot c${t.cat}` }), h('b', {}, toPrompt(t.name))),
        t.cn ? h('div', { class: 'tg-cn big' }, t.cn) : h('div', { class: 'faint' }, '词库里没有这个 TAG 的翻译'),
        h('div', { class: 'tg-meta' },
          h('span', { class: `tg-badge c${t.cat}` }, CAT_NAME[t.cat] || '其他'),
          t.count ? h('span', {}, `Danbooru 上 ${t.count.toLocaleString()} 张`) : null,
          h('a', { href: `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(t.name)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Danbooru 词条', icon('ext', 12))),
        d.alias_of ? h('div', { class: 'tg-alias-of' }, '这是别名，Danbooru 上实际用的是 ',
          h('button', { type: 'button', class: 'text-btn', onclick: () => { st.stack.pop(); openDetail(d.alias_of.name); } }, toPrompt(d.alias_of.name))) : null,
        h('div', { class: 'tg-actions' },
          h('button', { type: 'button', class: 'btn primary small tg-main', 'data-tag': t.name, onclick: () => toggle(t.name) }),
          h('button', {
            type: 'button', class: 'btn ghost small',
            onclick: () => navigator.clipboard.writeText(toPrompt(t.name)).then(() => toast('已复制'), () => toast('复制失败', 'error')),
          }, icon('copy', 14), '复制'),
          favorite ? h('button', { type: 'button', class: 'btn ghost small', onclick: (e) => favorite(toPrompt(t.name), e.currentTarget) }, icon('star', 14), '收藏') : null),
        d.remote_error ? h('div', { class: 'hint warn' }, d.remote_error) : null,
        chipList('别名（搜索它们也会找到这个 TAG）', d.aliases, false),
        chipList('其他名称', d.other_names, false),
        d.related.length ? h('div', { class: 'tg-sec' },
          h('div', { class: 'tg-sec-title' }, '相关 TAG（常和它一起出现）'),
          h('div', {}, ...d.related.map(row))) : null));
    paintMarks();
  }

  function backBtn() {
    return h('button', { type: 'button', class: 'tg-back', onclick: back }, icon('back', 14), st.stack.length > 1 ? '上一个' : '返回结果');
  }

  function back() {
    st.stack.pop();
    if (st.stack.length) openDetail(st.stack.pop());
    else {
      paintList();
      input.focus({ preventScroll: true });
    }
  }

  function open(query) {
    if (panel.hidden && initialTarget) st.target = initialTarget();
    panel.hidden = false;
    document.body.classList.add('tg-open');
    paintTargets();
    paintCats();
    if (query != null && query !== st.q) {
      input.value = query;
      st.q = query;
      st.stack = [];
      search();
    } else if (!st.stack.length) paintList();
    input.focus();
    input.select();
  }

  function close() {
    panel.hidden = true;
    document.body.classList.remove('tg-open');
  }

  /** 给一批 TAG 补上中文（自动补全用），只查没缓存过的 */
  async function translate(names) {
    const missing = [...new Set(names.map(tagKey))].filter((n) => n && !cnCache.has(n));
    if (missing.length) {
      try {
        const res = await api.tagLookup(missing);
        for (const n of missing) cnCache.set(n, res.items[n]?.cn || '');
      } catch {
        return false;
      }
    }
    return true;
  }

  return {
    open,
    close,
    toggleOpen: () => (panel.hidden ? open() : close()),
    get isOpen() { return !panel.hidden; },
    refreshTargets: () => { if (!panel.hidden) { paintTargets(); paintMarks(); } },
    reset() {
      close();
      st.ctl?.abort();
      Object.assign(st, { q: '', cat: null, items: [], target: 'prompt', stack: [] });
      input.value = '';
    },
    translate,
    cnOf: (name) => cnCache.get(tagKey(name)) || '',
    known: (name) => { const k = tagKey(name); return !k || cnCache.has(k); },
  };
}
