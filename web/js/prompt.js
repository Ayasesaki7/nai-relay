// 提示词：分段 / 权重 / 停用 / 随机词，以及「标签模式」编辑器
import { h, icon, clamp } from './util.js';

// ---------- 解析 ----------

/** 按顶层逗号（和换行）切分；`1.2::a, b::`、`{a, b}` 里的逗号不切 */
export function splitPrompt(text) {
  const out = [];
  let depth = 0;
  let weighted = false;
  let start = 0;
  const push = (s) => {
    s = s.trim();
    if (s) out.push(s);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ':' && text[i + 1] === ':') {
      weighted = !weighted;
      i++;
    } else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    else if ((c === ',' || c === '\n') && !depth && !weighted) {
      push(text.slice(start, i));
      start = i + 1;
    }
  }
  push(text.slice(start));
  return out;
}

const round2 = (w) => Math.round(w * 100) / 100;

/** 一段 → { text, weight, style: plain|num|brace, level, off } */
export function parseSeg(raw) {
  let s = raw.trim();
  let off = false;
  if (s.startsWith('//')) {
    off = true;
    s = s.slice(2).trim();
  }
  let m = s.match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)(?:::)?$/);
  if (m) return { text: m[2].trim(), weight: +m[1], style: 'num', level: 0, off };
  m = s.match(/^(\{+|\[+)([\s\S]*?)(\}+|\]+)$/);
  if (m && m[1].length === m[3].length && (m[1][0] === '{') === (m[3][0] === '}')) {
    const level = m[1][0] === '{' ? m[1].length : -m[1].length;
    return { text: m[2].trim(), weight: round2(1.05 ** level), style: 'brace', level, off };
  }
  return { text: s, weight: 1, style: 'plain', level: 0, off };
}

export function segText(seg) {
  let body = seg.text;
  if (seg.style === 'num' && Math.abs(seg.weight - 1) > 1e-9) body = `${round2(seg.weight)}::${seg.text}::`;
  else if (seg.style === 'brace' && seg.level) {
    const n = Math.abs(seg.level);
    body = seg.level > 0 ? `${'{'.repeat(n)}${seg.text}${'}'.repeat(n)}` : `${'['.repeat(n)}${seg.text}${']'.repeat(n)}`;
  }
  return (seg.off ? '//' : '') + body;
}

export const joinSegs = (segs) => segs.map(segText).join(', ');

/** 调权重：括号写法加减一层；其他按 0.1 调，写成 `1.2::tag::` */
export function bumpWeight(seg, dir) {
  if (seg.style === 'brace') {
    const level = clamp(seg.level + dir, -8, 8);
    return level ? { ...seg, level, weight: round2(1.05 ** level) } : { ...seg, style: 'plain', level: 0, weight: 1 };
  }
  let w = round2(clamp(seg.weight + dir * 0.1, -3, 3));
  if (Math.abs(w) < 1e-9) w = round2(dir * 0.1);
  return Math.abs(w - 1) < 1e-9 ? { ...seg, style: 'plain', weight: 1 } : { ...seg, style: 'num', weight: w };
}

/** 判断两段是不是同一个词（忽略权重、停用、大小写、下划线） */
export const segKey = (s) => parseSeg(s).text.toLowerCase().replace(/[_\s]+/g, ' ').trim();

export const WILD = /__([^_\s,][^_,]*?)__/g;
const HAS_WILD = /__([^_\s,][^_,]*?)__/;

/**
 * 生成前处理：去掉停用（// 开头）的段，把 __分类__ 换成随机一条。
 * 没有这两种写法时原样返回，不改格式。
 */
export function resolvePrompt(text, pickWild, depth = 0) {
  if (!text || (!/(^|[,\n])\s*\/\//.test(text) && !HAS_WILD.test(text))) return text;
  const segs = splitPrompt(text).filter((s) => !s.startsWith('//'));
  const out = segs.map((s) => s.replace(WILD, (m, name) => {
    const v = pickWild(name);
    return v == null ? m : depth < 3 ? resolvePrompt(v, pickWild, depth + 1) : v;
  }));
  return out.filter((s) => s.trim()).join(', ');
}

/** 把一组词加到文本末尾（已有的跳过）；返回新文本 */
export function addTo(text, addText) {
  const have = new Set(splitPrompt(text).map(segKey));
  const add = splitPrompt(addText).filter((s) => !have.has(segKey(s)));
  if (!add.length) return text;
  const v = text.replace(/[\s,]+$/, '');
  return v ? `${v}, ${add.join(', ')}` : add.join(', ');
}

/** 从文本里去掉这些词 */
export function removeFrom(text, removeText) {
  const drop = new Set(splitPrompt(removeText).map(segKey));
  return splitPrompt(text).filter((s) => !drop.has(segKey(s))).join(', ');
}

export function containsAll(text, part) {
  const have = new Set(splitPrompt(text).map(segKey));
  const need = splitPrompt(part).map(segKey);
  return need.length > 0 && need.every((k) => have.has(k));
}

// ---------- 撤销 ----------

const histories = new Map();

/** 每个输入框（按 data-hist 区分，重建也不丢）一份撤销栈 */
export function history(key) {
  if (!histories.has(key)) histories.set(key, { undo: [], redo: [] });
  return histories.get(key);
}

export function resetHistories() {
  histories.clear();
}

// ---------- 标签模式编辑器 ----------

/**
 * 把一个 textarea 换成标签块编辑器。textarea 仍是唯一的数据来源（隐藏起来），
 * 编辑器的改动都通过 edit(ta, value) 写回去，外部改了 textarea 会触发 input 重画。
 * opts: edit(ta, value), cnOf(text), translate(texts) → Promise<bool>, isKnown(text),
 *       attachSuggest(input), favorite(text, anchor), lookup(text)
 */
export function createTagBoard(ta, opts) {
  const st = { sel: new Set(), editing: -1, drag: null, segs: [] };
  const chips = h('div', { class: 'tb-chips' });
  const add = h('input', { class: 'tb-add', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: '添加…（逗号或回车确认）' });
  const btn = (ic, title, fn, cls = '') => h('button', { type: 'button', class: `tb-btn ${cls}`, title, onclick: fn }, icon(ic, 14));
  const wLabel = h('span', { class: 'tb-w', title: '权重' });
  const sel = h('span', { class: 'tb-sel' },
    btn('minus', '降低权重', () => bump(-1)), wLabel, btn('plus', '提高权重', () => bump(1)),
    btn('eye', '停用 / 启用（停用的词生成时不发送）', toggleOff),
    btn('star', '收藏所选', (e) => opts.favorite(joinSegs(selected()), e.currentTarget)),
    btn('search', '在 TAG 检索里查', () => opts.lookup(selected()[0].text)),
    btn('trash', '删除所选', removeSelected, 'danger'));
  const undoBtn = btn('undo', '撤销（Ctrl+Z）', undo);
  const redoBtn = btn('redo', '重做（Ctrl+Shift+Z）', redo);
  const count = h('span', { class: 'tb-count' });
  const bar = h('div', { class: 'tb-bar' }, undoBtn, redoBtn, h('i', { class: 'tb-sep' }), sel, count);
  const el = h('div', { class: 'tb', tabindex: '-1', 'data-for': ta.dataset.hist || '' }, chips, bar);
  el.ta = ta;
  ta.after(el);

  const hist = () => history(ta.dataset.hist || ta.id || 'x');

  function commit(value) {
    if (value === ta.value) return;
    const hs = hist();
    hs.undo.push(ta.value);
    if (hs.undo.length > 100) hs.undo.shift();
    hs.redo.length = 0;
    opts.edit(ta, value);
  }

  function undo() {
    const hs = hist();
    if (!hs.undo.length) return;
    hs.redo.push(ta.value);
    st.sel.clear();
    opts.edit(ta, hs.undo.pop());
  }

  function redo() {
    const hs = hist();
    if (!hs.redo.length) return;
    hs.undo.push(ta.value);
    st.sel.clear();
    opts.edit(ta, hs.redo.pop());
  }

  const selected = () => [...st.sel].sort((a, b) => a - b).map((i) => st.segs[i]).filter(Boolean);

  function setSegs(segs, selection) {
    st.sel = new Set(selection ?? []);
    commit(joinSegs(segs));
  }

  function bump(dir) {
    const segs = st.segs.map((s, i) => (st.sel.has(i) ? bumpWeight(s, dir) : s));
    setSegs(segs, st.sel);
  }

  function toggleOff() {
    const anyOn = selected().some((s) => !s.off);
    setSegs(st.segs.map((s, i) => (st.sel.has(i) ? { ...s, off: anyOn } : s)), st.sel);
  }

  function removeSelected() {
    setSegs(st.segs.filter((_, i) => !st.sel.has(i)), []);
  }

  function addText(text) {
    const parts = splitPrompt(text);
    if (!parts.length) return;
    const segs = [...st.segs, ...parts.map(parseSeg)];
    setSegs(segs, []);
  }

  function chip(seg, i) {
    const wild = /^__[^_].*__$/.test(seg.text);
    const cn = !wild && opts.cnOf(seg.text);
    const heavy = Math.abs(seg.weight - 1) > 1e-9;
    const w = heavy ? h('b', { class: `tb-wt${seg.weight < 1 ? ' down' : ''}` }, `${seg.weight}`) : null;
    const c = h('span', {
      class: `tb-chip${seg.off ? ' off' : ''}${st.sel.has(i) ? ' sel' : ''}${wild ? ' wild' : ''}${heavy ? (seg.weight > 1 ? ' up' : ' down') : ''}`,
      title: `${seg.text}${cn ? `\n${cn}` : ''}${seg.off ? '\n（已停用）' : ''}\n单击选中，Ctrl/Shift 多选，双击编辑，拖动排序`,
      'data-i': i,
    }, wild ? icon('dice', 12) : null, h('span', { class: 'tb-text' }, wild ? seg.text.slice(2, -2) : seg.text), cn ? h('small', {}, cn) : null, w);
    if (heavy) c.style.setProperty('--wk', weightStrength(seg.weight).toFixed(2));
    c.addEventListener('pointerdown', (e) => startDrag(e, i));
    c.addEventListener('dblclick', () => startEdit(i));
    return c;
  }

  function startEdit(i) {
    st.editing = i;
    render();
  }

  function editor(seg, i) {
    const input = h('input', { class: 'tb-edit', value: segText(seg), spellcheck: 'false' });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      st.editing = -1;
      if (save) {
        const parts = splitPrompt(input.value).map(parseSeg);
        const segs = [...st.segs.slice(0, i), ...parts, ...st.segs.slice(i + 1)];
        if (joinSegs(segs) !== ta.value) return setSegs(segs, []);
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    queueMicrotask(() => { input.focus(); input.select(); });
    return input;
  }

  // ---- 拖动排序（鼠标直接拖；触屏长按后拖） ----
  function startDrag(e, i) {
    if (e.button !== 0 || st.editing >= 0) return;
    const touch = e.pointerType === 'touch';
    const d = { i, x: e.clientX, y: e.clientY, on: false, at: -1, id: e.pointerId, t: Date.now(), touch, mods: e.ctrlKey || e.metaKey || e.shiftKey, shift: e.shiftKey };
    st.drag = d;
    if (touch) d.timer = setTimeout(() => { if (st.drag === d) begin(d); }, 280);
    const move = (ev) => {
      if (ev.pointerId !== d.id) return;
      const far = Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5;
      if (!d.on) {
        if (!far) return;
        if (touch) { // 没长按就滑动：当作滚动
          cleanup();
          return;
        }
        begin(d);
      }
      ev.preventDefault();
      d.at = dropIndex(ev.clientX, ev.clientY);
      for (const c of chips.querySelectorAll('.tb-chip')) {
        const k = +c.dataset.i;
        c.classList.toggle('drop-before', k === d.at);
        c.classList.toggle('drop-after', d.at === st.segs.length && k === st.segs.length - 1);
      }
    };
    const up = (ev) => {
      if (ev.pointerId !== d.id) return;
      cleanup();
      if (d.on) {
        if (d.at >= 0) moveTo(d.at);
        else render();
      } else if (ev.type === 'pointerup') click(i, d);
    };
    const cleanup = () => {
      clearTimeout(d.timer);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (st.drag === d) st.drag = null;
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function begin(d) {
    d.on = true;
    if (!st.sel.has(d.i)) {
      st.sel = new Set([d.i]);
      paintSel();
    }
    el.classList.add('dragging');
  }

  // 触屏拖动时不让页面跟着滚
  el.addEventListener('touchmove', (e) => { if (st.drag?.on) e.preventDefault(); }, { passive: false });

  function dropIndex(x, y) {
    const list = [...chips.querySelectorAll('.tb-chip')];
    let best = list.length;
    for (const c of list) {
      const r = c.getBoundingClientRect();
      if (y < r.top - 4) { best = +c.dataset.i; break; }
      if (y <= r.bottom + 4 && x < r.left + r.width / 2) { best = +c.dataset.i; break; }
    }
    return best >= list.length ? st.segs.length : best;
  }

  function moveTo(at) {
    const picked = selected();
    const before = [...st.sel].filter((k) => k < at).length;
    const rest = st.segs.filter((_, k) => !st.sel.has(k));
    const pos = at - before;
    const segs = [...rest.slice(0, pos), ...picked, ...rest.slice(pos)];
    setSegs(segs, picked.map((_, k) => pos + k));
  }

  let anchor = -1;
  function click(i, d) {
    if (d.shift && anchor >= 0) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let k = a; k <= b; k++) st.sel.add(k);
    } else if (d.mods) {
      if (st.sel.has(i)) st.sel.delete(i);
      else st.sel.add(i);
      anchor = i;
    } else {
      st.sel = st.sel.size === 1 && st.sel.has(i) ? new Set() : new Set([i]);
      anchor = i;
    }
    paintSel();
    el.focus({ preventScroll: true });
  }

  function paintSel() {
    for (const c of chips.querySelectorAll('.tb-chip')) c.classList.toggle('sel', st.sel.has(+c.dataset.i));
    const s = selected();
    sel.classList.toggle('on', s.length > 0);
    for (const b of sel.querySelectorAll('button')) b.disabled = !s.length;
    sel.querySelector('[title^="在 TAG"]').disabled = s.length !== 1;
    wLabel.textContent = s.length ? (s.every((x) => x.weight === s[0].weight) ? `×${s[0].weight}` : '混合') : '×1';
    count.textContent = s.length ? `已选 ${s.length}` : `${st.segs.length} 个词`;
    const hs = hist();
    undoBtn.disabled = !hs.undo.length;
    redoBtn.disabled = !hs.redo.length;
  }

  function render() {
    st.segs = splitPrompt(ta.value).map(parseSeg);
    for (const k of [...st.sel]) if (k >= st.segs.length) st.sel.delete(k);
    // 输入框不移出 DOM，否则重画时（比如中文释义异步到了）会丢焦点
    for (const c of [...chips.children]) if (c !== add) c.remove();
    if (add.parentNode !== chips) chips.append(add);
    add.before(...st.segs.map((s, i) => (i === st.editing ? editor(s, i) : chip(s, i))));
    add.placeholder = st.segs.length ? '添加…' : (ta.placeholder || '添加…（逗号或回车确认）');
    paintSel();
    const missing = st.segs.map((s) => s.text).filter((t) => !opts.isKnown(t) && !/^__/.test(t));
    if (missing.length) opts.translate(missing).then((ok) => { if (ok && st.editing < 0 && !st.drag) render(); });
  }

  // 输入框：打逗号或回车就把前面的词加进去
  opts.attachSuggest(add);
  add.addEventListener('input', () => {
    const v = add.value;
    const cut = Math.max(v.lastIndexOf(','), v.lastIndexOf('\n'));
    if (cut < 0) return;
    add.value = v.slice(cut + 1).trimStart();
    addText(v.slice(0, cut));
    add.focus();
  });
  add.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = add.value;
      add.value = '';
      addText(v);
      add.focus();
    } else if ((e.ctrlKey || e.metaKey) && !add.value && /^[zy]$/i.test(e.key)) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
      else undo();
    } else if (e.key === 'Backspace' && !add.value && st.segs.length) {
      e.preventDefault();
      st.sel = new Set([st.segs.length - 1]);
      paintSel();
      el.focus({ preventScroll: true });
    }
  });
  add.addEventListener('focus', () => { if (st.sel.size) { st.sel.clear(); paintSel(); } });
  chips.addEventListener('click', (e) => { if (e.target === chips) add.focus(); });

  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); st.sel = new Set(st.segs.map((_, i) => i)); paintSel(); }
    else if (!st.sel.size) return;
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); removeSelected(); el.focus(); }
    else if (k === 'arrowup' || k === '+' || k === '=') { e.preventDefault(); bump(1); }
    else if (k === 'arrowdown' || k === '-') { e.preventDefault(); bump(-1); }
    else if (k === 'escape') { st.sel.clear(); paintSel(); }
    else if (k === 'enter' && st.sel.size === 1) { e.preventDefault(); startEdit([...st.sel][0]); }
  });

  ta.addEventListener('input', () => { if (el.isConnected && el.offsetParent !== null && st.editing < 0) render(); });

  return { el, render, undo, redo };
}

// ---------- 文本模式的权重高亮 ----------

/** 权重 → 高亮强度 0..1：1.05 也看得出来，±0.5 以上最深 */
export const weightStrength = (w) => clamp(0.3 + Math.abs(w - 1) * 1.4, 0.3, 1);

/** 每个顶层片段的位置和权重，只返回需要高亮的：加权、降权、停用 */
export function weightRanges(text) {
  const out = [];
  let depth = 0;
  let weighted = false;
  let start = 0;
  const push = (a, b) => {
    const raw = text.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) return;
    const seg = parseSeg(body);
    const s = a + lead;
    const e = s + body.length;
    if (seg.off) out.push({ start: s, end: e, kind: 'off' });
    else if (Math.abs(seg.weight - 1) > 1e-9) out.push({ start: s, end: e, kind: seg.weight > 1 ? 'up' : 'down', weight: seg.weight });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ':' && text[i + 1] === ':') {
      weighted = !weighted;
      i++;
    } else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    else if ((c === ',' || c === '\n') && !depth && !weighted) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out;
}

const highlighters = new Set();
const COPY_STYLE = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
  'borderLeftWidth', 'textIndent', 'textTransform'];

/**
 * 在 textarea 后面垫一层，把加权的词涂上底色（文字还是 textarea 自己画的，所以光标、选择都不受影响）。
 * 加权绿色、降权红色，越偏离 1 颜色越深；停用的词灰色。
 */
export function attachWeightHighlight(ta) {
  const wrap = h('div', { class: 'hl-wrap' });
  const back = h('div', { class: 'hl-back', 'aria-hidden': 'true' });
  ta.before(wrap);
  wrap.append(back, ta);
  ta.classList.add('hl-ta');
  let last = null;

  function layout() {
    const cs = getComputedStyle(ta);
    for (const k of COPY_STYLE) back.style[k] = cs[k];
    // textarea 出滚动条时内容区变窄，垫层跟着变窄才能对齐换行
    const bw = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    back.style.width = `${ta.clientWidth + bw}px`;
    back.style.height = `${ta.offsetHeight}px`;
    back.scrollTop = ta.scrollTop;
  }

  function update() {
    const text = ta.value;
    if (text === last) return;
    last = text;
    const nodes = [];
    let pos = 0;
    for (const r of weightRanges(text)) {
      if (r.start > pos) nodes.push(text.slice(pos, r.start));
      const m = h('mark', { class: `hl-${r.kind}` }, text.slice(r.start, r.end));
      if (r.weight != null) m.style.setProperty('--wk', weightStrength(r.weight).toFixed(2));
      nodes.push(m);
      pos = r.end;
    }
    nodes.push(`${text.slice(pos)}\n`); // 末尾换行也要占一行高
    back.replaceChildren(...nodes);
    back.scrollTop = ta.scrollTop;
  }

  ta.addEventListener('input', update);
  ta.addEventListener('scroll', () => { back.scrollTop = ta.scrollTop; });
  new ResizeObserver(layout).observe(ta);
  const hl = { ta, update, layout };
  highlighters.add(hl);
  layout();
  update();
  return hl;
}

/** 程序直接改了 textarea.value（没触发 input）之后调用 */
export function refreshWeightHighlights() {
  for (const hl of [...highlighters]) {
    if (!hl.ta.isConnected) highlighters.delete(hl);
    else hl.update();
  }
}
