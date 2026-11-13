// 新版界面（studio.html）的外壳：左侧导航、页面切换、创作区的分组标签。
// 功能模块（图库、灵感、素材、词库、助手）两版共用，这里只负责把它们放进独立页面而不是弹窗。
import { $, h, icon, safeStorage } from './util.js';

export const UI_MODE = document.documentElement.dataset.ui === 'studio' ? 'studio' : 'classic';

export function switchUi(to) {
  document.cookie = `nai_ui=${to}; path=/; max-age=31536000; SameSite=Lax`;
  location.reload();
}

const PAGES = {
  create: { title: '创作', icon: 'wand' },
  agent: { title: '助手', icon: 'sparkles', sub: '让大模型帮你写提示词、查 TAG、调参数，批准后出图' },
  booru: { title: '灵感', icon: 'compass', sub: '在图片站找图、看 TAG，一键加到提示词' },
  gallery: { title: '图库', icon: 'cloud', sub: '收藏到服务器的图片，换设备也能看到' },
  assets: { title: '素材', icon: 'layers', sub: '常用的角色参考、氛围参考图' },
  library: { title: '词库', icon: 'book', sub: '收藏的词、固定词、提示词快照' },
};
const RAIL_ICONS = { ...Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [k, v.icon])), manage: 'shield', switch: 'swap' };
const WORK = new Set(['create', 'agent']);
const PAGE_STORAGE = 'nai-studio:page';
const TAB_STORAGE = 'nai-studio:tab';

/**
 * hooks.open[页面]()：打开该页面的模块（模块会调用 openPage 把内容放进来）
 * hooks.openAgent / closeAgent：助手停靠在创作区左侧
 */
export function createShell(hooks) {
  const st = { page: 'create', pending: null, moving: false, closers: {}, started: false, tab: safeStorage(TAB_STORAGE) || 'prompt' };

  for (const el of document.querySelectorAll('.st-ic')) el.append(icon(RAIL_ICONS[el.dataset.icon], 20));
  for (const b of document.querySelectorAll('[data-nav]')) b.addEventListener('click', () => nav(b.dataset.nav));
  for (const b of $('#st-tabs').children) b.addEventListener('click', () => setTab(b.dataset.tab));
  setTab(st.tab);
  // 参考图数量显示在标签上；有新参考图加进来时闪一下
  let refCount = 0;
  const paintBadges = () => {
    const n = [...document.querySelectorAll('#ref-tabs .badge')].reduce((a, b) => a + (parseInt(b.textContent, 10) || (b.textContent.trim() ? 1 : 0)), 0);
    const el = document.querySelector('[data-badge="ref"]');
    el.textContent = n || '';
    if (n > refCount && st.tab !== 'ref') {
      const tab = el.parentElement;
      tab.classList.remove('flash');
      void tab.offsetWidth;
      tab.classList.add('flash');
    }
    refCount = n;
  };
  new MutationObserver(paintBadges).observe($('#ref-tabs'), { subtree: true, childList: true, characterData: true });
  paint();

  function setTab(tab) {
    if (!['prompt', 'ref', 'param'].includes(tab)) tab = 'prompt';
    st.tab = tab;
    safeStorage(TAB_STORAGE, tab === 'prompt' ? null : tab);
    for (const b of $('#st-tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
    for (const s of document.querySelectorAll('.controls .sec[data-tab]')) s.hidden = s.dataset.tab !== tab;
    $('.controls-scroll').scrollTop = 0;
  }

  function paint() {
    document.body.dataset.page = st.page;
    for (const b of document.querySelectorAll('[data-nav]')) b.classList.toggle('on', b.dataset.nav === st.page);
    $('#st-title').textContent = PAGES[st.page].title;
    $('#st-sub').textContent = PAGES[st.page].sub || '';
    for (const p of document.querySelectorAll('.st-page')) p.hidden = p.dataset.page !== st.page;
  }

  function nav(page) {
    if (!PAGES[page]) page = 'create';
    if (!st.started && page !== 'create') return;
    // 关掉上一个页面时它可能回头要求跳回创作页，切换途中一律忽略
    if (st.page === page || st.moving) return;
    const prev = st.page;
    st.page = page;
    st.moving = true;
    try {
      paint();
      safeStorage(PAGE_STORAGE, page === 'create' ? null : page);
      if (prev === 'agent') hooks.closeAgent();
      else if (!WORK.has(prev)) st.closers[prev]?.();
      if (page === 'agent') hooks.openAgent();
      else if (!WORK.has(page)) {
        st.pending = page;
        hooks.open[page]();
      }
    } finally {
      st.pending = null;
      st.moving = false;
    }
    document.querySelector('.st-main').scrollTop = 0;
  }

  /** 模块要打开主窗口时先问这里：是导航触发的就放进页面，否则返回 null 让它照常弹窗 */
  function openPage(opts) {
    const name = st.pending;
    if (!name) return null;
    st.pending = null;
    const host = document.querySelector(`.st-page[data-page="${name}"]`);
    host.replaceChildren(h('div', { class: `modal as-page ${opts.cls || ''}` }, h('div', { class: 'modal-body' }, opts.body)));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (st.closers[name] === close) delete st.closers[name];
      host.replaceChildren();
      opts.onClose?.();
      if (st.page === name) nav('create');
    };
    st.closers[name] = close;
    return close;
  }

  return {
    nav,
    openPage,
    setTab,
    /** 页面上能不能响应创作区的快捷键、拖放 */
    workActive: () => WORK.has(st.page),
    /** 登录后恢复上次的页面 */
    start() {
      st.started = true;
      const last = safeStorage(PAGE_STORAGE);
      if (last && PAGES[last]) nav(last);
    },
    /** 退出登录：回到创作页 */
    stop() {
      if (st.page !== 'create') nav('create');
      st.started = false;
    },
  };
}
