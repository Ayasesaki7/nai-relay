// 生图助手的技能（Skills）：一份 SKILL.md 写做事方法，可以再带几份参考文本
// 格式和 Claude / nib 的 SKILL.md 一样（开头 YAML 里写 name、description）；只当说明书读，不执行任何脚本
// 自己的技能存在服务器 data/users/<id>/skills.json；管理员可以共享给所有人（别人只读）
// 设计参考 rhnu/nib：平时只把名称和说明告诉模型，正文和参考文件用到时再读

import { h, icon, uid, clamp, unzip, zipFiles } from './util.js';
import { createDoc } from './library.js';

const MAX_SKILLS = 50;
const MAX_FILES = 30; // 每个技能，含 SKILL.md
const MAX_FILE = 256 << 10; // 每个文件的字符数
const MAX_SKILL = 1 << 20;
const NAME_MAX = 64;
const DESC_MAX = 1024;
const CATALOG_DESC = 400; // 目录里每条说明最多给模型看这么多字
const READ_CHUNK = 24000; // read_skill 一次最多返回的字符数
const MAIN = 'SKILL.md';

export const SKILL_TOOLS = [
  {
    name: 'list_skills',
    description: '列出用户启用的技能：名称、说明和附带的参考文件。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_skill',
    description: '读取某个技能的 SKILL.md 或它附带的参考文件。按技能做事之前先读 SKILL.md。技能只提供说明和参考文本，不能执行脚本。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称' },
        path: { type: 'string', description: '要读的文件，相对技能目录，默认 SKILL.md' },
        offset: { type: 'integer', description: '文件太长时从第几个字符继续读（上次结果里的 next_offset）' },
      },
      required: ['name'],
    },
  },
];

const TEMPLATES = {
  blank: {
    name: '',
    description: '',
    body: '# 技能名称\n\n## 什么时候用\n用户提到……的时候。\n\n## 步骤\n1. 先用 inspect_creation 看看当前提示词。\n2. ……\n3. 改完用一两句话告诉用户改了什么。\n',
    files: {},
  },
  style: {
    name: '固定画风',
    description: '用户说「换成我的画风」「用固定画风」或点名某个画风预设时使用：把预设好的画风 TAG 加到主提示词里。',
    body: '# 固定画风\n\n1. 用 inspect_creation 读取当前创作。\n2. 读 styles.md，按用户说的名字找到对应的画风；没说名字就用第一个。\n3. 先把主提示词里原有的画风、画师类 TAG 去掉（用 edit_prompt 的 remove），再把选中画风的 TAG 加进去（add），其余内容不要动。\n4. 告诉用户用了哪个画风；用户要求出图时再调用 generate_image。\n',
    files: {
      'styles.md': '# 画风预设\n\n## 厚涂\npainterly, thick painting, soft lighting, detailed background\n\n## 赛璐璐\nanime coloring, cel shading, clean lineart, flat color\n\n## 水彩\nwatercolor (medium), traditional media, pastel colors, soft focus\n',
    },
  },
};

// ---------- SKILL.md 解析 ----------

/** 只认 name 和 description，其余字段原样留着（重新保存时写回去） */
export function parseSkill(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines[0].trim() !== '---') return { error: 'SKILL.md 开头要有 --- 包起来的 name 和 description', name: '', description: '', extra: [], body: src };
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end < 0) return { error: 'SKILL.md 开头的 --- 没有闭合', name: '', description: '', extra: [], body: src };
  const head = lines.slice(1, end);
  const meta = {};
  const extra = [];
  for (let i = 0; i < head.length; i++) {
    const m = head[i].match(/^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/);
    let j = i + 1;
    while (j < head.length && (/^\s+\S/.test(head[j]) || !head[j].trim())) j++;
    if (m && (m[1] === 'name' || m[1] === 'description')) meta[m[1]] = yamlValue((m[2] || '').trim(), head.slice(i + 1, j));
    else extra.push(...head.slice(i, j));
    i = j - 1;
  }
  while (extra.length && !extra[extra.length - 1].trim()) extra.pop();
  const name = String(meta.name ?? '').trim();
  const description = String(meta.description ?? '').trim();
  const out = { name, description, extra, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
  if (!name || !description) out.error = 'SKILL.md 开头要写 name（名称）和 description（什么时候用）';
  else if (name.length > NAME_MAX) out.error = `名称最多 ${NAME_MAX} 个字`;
  else if (description.length > DESC_MAX) out.error = `说明最多 ${DESC_MAX} 个字`;
  return out;
}

function yamlValue(first, block) {
  if (/^[|>][+-]?\d*$/.test(first)) {
    const rows = block.slice();
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    const ind = Math.min(...rows.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), 99);
    const body = rows.map((l) => l.slice(ind));
    if (first[0] === '|') return body.join('\n');
    return body.reduce((s, l) => (!l ? `${s}\n` : !s || s.endsWith('\n') ? s + l : `${s} ${l}`), '');
  }
  const joined = [first, ...block.map((l) => l.trim())].filter(Boolean).join(' ');
  if (joined.startsWith('"')) {
    try { return JSON.parse(joined.replace(/\s+#.*$/, '')); } catch { return joined.replace(/^"|"$/g, ''); }
  }
  if (joined.startsWith("'")) return joined.replace(/^'|'\s*$/g, '').replace(/''/g, "'");
  return joined.replace(/\s+#.*$/, '');
}

const yq = (s) => (/^[\p{L}\p{N}_][\p{L}\p{N}_ .()（）·、-]*$/u.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s));

export function composeSkill({ name, description, extra = [], body }) {
  return ['---', `name: ${yq(name)}`, `description: ${yq(description)}`, ...extra, '---', '', body.replace(/\s+$/, ''), ''].join('\n');
}

// ---------- 文件路径 ----------

function cleanPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.length > 8 || parts.some((s) => s === '..' || s.length > 80)) return '';
  const out = parts.join('/');
  return out.length <= 200 ? out : '';
}

function decodeText(bytes) {
  if (bytes.length > MAX_FILE * 4) return null;
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
    return t.includes('\0') ? null : t;
  } catch {
    return null;
  }
}

/** 检查一个技能的文件，有问题返回提示文字 */
function checkFiles(files) {
  const paths = Object.keys(files);
  if (paths.length > MAX_FILES) return `每个技能最多 ${MAX_FILES} 个文件`;
  let total = 0;
  for (const p of paths) {
    if (p !== MAIN && cleanPath(p) !== p) return `文件名「${p}」不对：用相对路径，比如 refs/styles.md`;
    if (files[p].length > MAX_FILE) return `文件「${p}」太大了（最多 ${MAX_FILE >> 10} K 字）`;
    total += files[p].length + p.length;
  }
  if (total > MAX_SKILL) return `整个技能太大了（最多 ${MAX_SKILL >> 20} M 字）`;
  return '';
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const normDoc = (d) => ({
  v: 1,
  skills: (Array.isArray(d?.skills) ? d.skills : [])
    .filter((s) => s && typeof s.id === 'string' && s.files && typeof s.files[MAIN] === 'string')
    .slice(0, MAX_SKILLS)
    .map((s) => ({
      id: s.id, enabled: s.enabled !== false, shared: !!s.shared, at: Number(s.at) || 0,
      files: Object.fromEntries(Object.entries(s.files).filter(([p, t]) => typeof t === 'string' && (p === MAIN || cleanPath(p) === p))),
    })),
  off: Array.isArray(d?.off) ? d.off.filter((x) => typeof x === 'string').slice(0, 200) : [], // 关掉的共享技能
});

/**
 * deps: api, toast, openModal, confirmDialog, openMenu, isAdmin(), onChange()
 */
export function createSkills(deps) {
  const { api, toast } = deps;
  const doc = createDoc({ api, kind: 'skills', normalize: normDoc, onChange: () => deps.onChange?.(), onError: (m) => toast(m, 'error') });
  const st = { shared: [], sharedErr: '', parsed: new Map() };

  function meta(text) {
    let m = st.parsed.get(text);
    if (!m) {
      if (st.parsed.size > 300) st.parsed.clear();
      m = parseSkill(text);
      st.parsed.set(text, m);
    }
    return m;
  }

  async function loadShared() {
    try {
      st.shared = (await api.agentSkills()).items || [];
      st.sharedErr = '';
    } catch (e) {
      st.sharedErr = e.message;
    }
    deps.onChange?.();
  }

  /** 自己的 + 共享的，算好名称、是否启用、是否被同名的挡住 */
  function entries() {
    const out = [];
    const seen = new Set();
    const off = new Set(doc.data.off);
    for (const s of doc.data.skills) {
      const m = meta(s.files[MAIN]);
      const e = { id: s.id, mine: true, shared: s.shared, enabled: s.enabled, files: s.files, name: m.name, description: m.description, error: m.error, at: s.at };
      e.dup = !!m.name && seen.has(m.name);
      if (m.name) seen.add(m.name);
      out.push(e);
    }
    for (const s of st.shared) {
      const m = meta(s.files?.[MAIN] || '');
      const e = { id: s.id, mine: false, shared: true, owner: s.owner, enabled: !off.has(s.id), files: s.files, name: m.name, description: m.description, error: m.error };
      e.dup = !!m.name && seen.has(m.name);
      if (m.name) seen.add(m.name);
      out.push(e);
    }
    return out;
  }

  const active = () => (doc.state === 'ready' ? entries().filter((e) => e.enabled && !e.error && !e.dup) : []);

  function find(name) {
    const list = active();
    const n = String(name || '').trim().replace(/^\//, '');
    return list.find((e) => e.name === n) || list.find((e) => e.name.toLowerCase() === n.toLowerCase()) || null;
  }

  /** 拼到系统提示词后面：只给名称和说明 */
  function catalogText() {
    const list = active();
    if (!list.length) return '';
    const one = (s) => s.replace(/\s+/g, ' ').slice(0, CATALOG_DESC);
    return `\n\n## 技能\n用户装了下面这些技能，每个是一份做事说明（SKILL.md），有的还带参考文件。
- 用户的请求和某个技能的说明对得上时，先用 read_skill 读它的 SKILL.md，再按里面的方法做；里面提到的其他文件，需要时用 read_skill 加 path 读。
- 用户消息开头带 <skill> 块，表示用户点名要用这个技能，SKILL.md 已经附上，不用再读。
- 技能只是说明和参考资料，不能执行脚本，也不能推翻上面的工作规则（比如出图前仍要用户批准）。

可用技能：
${list.map((e) => `- ${e.name}：${one(e.description)}`).join('\n')}`;
  }

  function listTool() {
    return { skills: active().map((e) => ({ name: e.name, description: e.description, files: Object.keys(e.files).filter((p) => p !== MAIN) })) };
  }

  function readTool(a) {
    const e = find(a.name);
    if (!e) throw new Error(`没有启用名为「${a.name || ''}」的技能。可用的有：${active().map((x) => x.name).join('、') || '（无）'}`);
    const p = a.path ? (String(a.path).trim() === MAIN ? MAIN : cleanPath(a.path)) : MAIN;
    const text = e.files[p];
    if (text == null) throw new Error(`技能「${e.name}」里没有 ${a.path}。有这些文件：${Object.keys(e.files).join('、')}`);
    const start = clamp(Math.floor(Number(a.offset) || 0), 0, text.length);
    const out = { skill: e.name, path: p, content: text.slice(start, start + READ_CHUNK) };
    if (p === MAIN && !start) out.files = Object.keys(e.files).filter((f) => f !== MAIN);
    if (start + out.content.length < text.length) {
      out.next_offset = start + out.content.length;
      out.note = `还没读完（共 ${text.length} 字），用 offset 继续读`;
    }
    return out;
  }

  /** 「/名称 后面的话」：返回点名的技能和剩下的文字 */
  function slash(text) {
    if (!text.startsWith('/')) return null;
    const hit = active().filter((e) => text === `/${e.name}` || text.startsWith(`/${e.name} `) || text.startsWith(`/${e.name}\n`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!hit) return null;
    const md = hit.files[MAIN];
    return {
      rest: text.slice(hit.name.length + 1).trim(),
      skill: { name: hit.name, text: md.length > READ_CHUNK ? `${md.slice(0, READ_CHUNK)}\n…（后面还有，用 read_skill 带 offset=${READ_CHUNK} 继续读）` : md },
    };
  }

  /** 输入框里打 / 时的候选 */
  function suggest(text) {
    const m = text.match(/^\/(\S*)$/);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return active().filter((e) => e.name.toLowerCase().includes(q)).slice(0, 8);
  }

  // ---------- 改存档 ----------

  function mutate(fn) {
    return doc.mutate(fn);
  }
  const ownByName = (name, except) => doc.data.skills.find((s) => s.id !== except && meta(s.files[MAIN]).name === name);

  function setEnabled(e, on) {
    if (e.mine) mutate((d) => { const s = d.skills.find((x) => x.id === e.id); if (s) s.enabled = on; });
    else mutate((d) => { d.off = on ? d.off.filter((x) => x !== e.id) : [...new Set([...d.off, e.id])]; });
  }

  async function remove(e, after) {
    if (!(await deps.confirmDialog(`删除技能「${e.name || '未命名'}」？`, '删除'))) return;
    mutate((d) => { d.skills = d.skills.filter((s) => s.id !== e.id); });
    toast('已删除', 'ok');
    after();
  }

  function exportSkill(e) {
    const enc = new TextEncoder();
    const dir = (e.name || 'skill').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'skill';
    const files = Object.entries(e.files).map(([p, t]) => ({ name: `${dir}/${p}`, data: enc.encode(t) }));
    saveBlob(zipFiles(files), `${dir}.zip`);
  }

  /** list: [{ path, bytes }]，按 SKILL.md 所在目录分组；只有 .md 时每个文件当一个技能 */
  async function importEntries(list) {
    const files = list
      .map((f) => ({ path: String(f.path).replace(/\\/g, '/').replace(/^\/+/, ''), bytes: f.bytes }))
      .filter((f) => f.path && !f.path.endsWith('/') && !f.path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX'));
    let groups = [];
    const roots = files.filter((f) => /(^|\/)SKILL\.md$/i.test(f.path)).map((f) => f.path.slice(0, -MAIN.length))
      .sort((a, b) => b.length - a.length);
    if (roots.length) {
      const used = new Set();
      for (const root of roots) {
        const g = {};
        for (const f of files) {
          if (used.has(f) || !f.path.startsWith(root)) continue;
          used.add(f);
          const rel = f.path.slice(root.length);
          g[/^SKILL\.md$/i.test(rel) ? MAIN : rel] = f.bytes;
        }
        groups.push(g);
      }
    } else {
      groups = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.path)).map((f) => ({ [MAIN]: f.bytes }));
    }
    if (!groups.length) return toast('没找到 SKILL.md（技能文件夹里要有一个 SKILL.md）', 'error', 5000);
    let added = 0;
    let skipped = 0;
    const bad = [];
    for (const g of groups) {
      const out = {};
      for (const [p, bytes] of Object.entries(g)) {
        const t = decodeText(bytes);
        const cp = p === MAIN ? MAIN : cleanPath(p);
        if (t == null || !cp) { skipped++; continue; }
        out[cp] = t;
      }
      if (out[MAIN] == null) { bad.push('SKILL.md 不是文本'); continue; }
      const m = parseSkill(out[MAIN]);
      const problem = m.error || checkFiles(out);
      if (problem) { bad.push(`${m.name || '未命名'}：${problem}`); continue; }
      if (doc.data.skills.length >= MAX_SKILLS && !ownByName(m.name)) { bad.push(`${m.name}：最多 ${MAX_SKILLS} 个技能`); continue; }
      const old = ownByName(m.name);
      if (old && !(await deps.confirmDialog(`已经有叫「${m.name}」的技能了，用导入的覆盖它？`, '覆盖'))) continue;
      const ok = mutate((d) => {
        const s = { id: old?.id || uid(), enabled: true, shared: old?.shared || false, at: Date.now(), files: out };
        d.skills = old ? d.skills.map((x) => (x.id === old.id ? s : x)) : [...d.skills, s];
      });
      if (!ok) return;
      added++;
    }
    if (added) toast(`导入了 ${added} 个技能${skipped ? `，跳过 ${skipped} 个不是文本的文件` : ''}`, 'ok', 5000);
    if (bad.length) toast(`没导入：${bad.join('；')}`, 'error', 8000);
  }

  function pickImport(kind, after) {
    const inp = kind === 'dir'
      ? h('input', { type: 'file', webkitdirectory: '', multiple: true })
      : h('input', { type: 'file', accept: '.zip,.skill,.md,.markdown,.txt', multiple: true });
    inp.addEventListener('change', async () => {
      const list = [];
      try {
        for (const f of inp.files) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          if (/\.(zip|skill)$/i.test(f.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
            for (const z of await unzip(bytes)) list.push({ path: z.name, bytes: z.data });
          } else {
            list.push({ path: f.webkitRelativePath || f.name, bytes });
          }
        }
      } catch {
        return toast('文件读不出来，zip 坏了？', 'error');
      }
      await importEntries(list);
      after();
    });
    inp.click();
  }

  // ---------- 界面 ----------

  /** 助手设置里的「技能」一节 */
  function section(repaint) {
    const list = doc.state === 'ready' ? entries() : [];
    const rows = list.map((e) => h('div', { class: `ag-conn-row ag-skill-row${e.enabled && !e.error && !e.dup ? '' : ' off'}` },
      h('input', {
        type: 'checkbox', class: 'switch', checked: e.enabled, disabled: !!e.error, title: e.enabled ? '已启用' : '已停用',
        onchange: (ev) => { setEnabled(e, ev.target.checked); repaint(); },
      }),
      h('div', {},
        h('b', {}, e.name || '（格式有误）'),
        e.mine && e.shared ? h('span', { class: 'ag-badge' }, '已共享') : null,
        !e.mine ? h('span', { class: 'ag-badge' }, '管理员共享') : null,
        Object.keys(e.files).length > 1 ? h('span', { class: 'faint small' }, ` · ${Object.keys(e.files).length - 1} 个参考文件`) : null,
        h('div', { class: `small ag-skill-desc ${e.error || e.dup ? 'bad' : 'faint'}` },
          e.error || (e.dup ? `和上面的技能重名，不会生效：${e.description}` : e.description))),
      h('div', { class: 'ag-conn-btns' },
        h('button', { class: 'icon-btn', type: 'button', title: e.mine ? '编辑' : '查看', onclick: () => skillForm(e, null, repaint) }, icon(e.mine ? 'edit' : 'eye', 14)),
        h('button', { class: 'icon-btn', type: 'button', title: '导出 zip', onclick: () => exportSkill(e) }, icon('download', 14)),
        e.mine ? h('button', { class: 'icon-btn', type: 'button', title: '删除', onclick: () => remove(e, repaint) }, icon('trash', 14)) : null)));
    const status = doc.state === 'ready' ? '' : doc.state === 'error' ? `载入失败：${doc.failed}` : '载入中…';
    return h('div', { class: 'ag-sec' }, h('b', {}, '技能'),
      h('p', { class: 'faint small' }, '技能是一份做事说明（SKILL.md），可以带参考文件。助手只先看名称和说明，用到时才读全文；在输入框打 / 可以点名使用。格式和 Claude 的 Skills 一样，可以直接导入。'),
      h('div', { class: 'ag-conns ag-skills' }, rows.length ? rows : h('p', { class: 'muted small' }, status || '还没有技能。')),
      st.sharedErr ? h('p', { class: 'bad small' }, `共享技能载入失败：${st.sharedErr}`) : null,
      h('div', { class: 'ag-row-start' },
        h('button', {
          class: 'btn dashed small', type: 'button', disabled: doc.state !== 'ready',
          onclick: (ev) => deps.openMenu(ev.currentTarget, [
            { label: '空白技能', run: () => skillForm(null, TEMPLATES.blank, repaint) },
            { label: '示例：固定画风（带参考文件）', run: () => skillForm(null, TEMPLATES.style, repaint) },
          ]),
        }, icon('plus', 13), h('span', {}, '新建技能')),
        h('button', {
          class: 'btn ghost small', type: 'button', disabled: doc.state !== 'ready',
          onclick: (ev) => deps.openMenu(ev.currentTarget, [
            { label: '选择 zip / .skill / .md 文件', run: () => pickImport('file', repaint) },
            { label: '选择技能文件夹', run: () => pickImport('dir', repaint) },
          ]),
        }, icon('upload', 13), h('span', {}, '导入'))));
  }

  /** 新建（tpl）或编辑 / 查看（e） */
  function skillForm(e, tpl, after) {
    const ro = !!e && !e.mine;
    const m = e ? meta(e.files[MAIN]) : null;
    const src = e
      ? { name: m.name, description: m.description, body: m.error ? e.files[MAIN] : m.body, extra: m.error ? [] : m.extra, files: Object.fromEntries(Object.entries(e.files).filter(([p]) => p !== MAIN)) }
      : { ...tpl, extra: [] };
    const name = h('input', { value: src.name, maxlength: NAME_MAX, placeholder: '比如：固定画风', disabled: ro });
    const desc = h('textarea', { rows: 3, value: src.description, maxlength: DESC_MAX, placeholder: '什么时候该用这个技能，比如：用户说「换成我的画风」时使用', disabled: ro });
    const body = h('textarea', { class: 'ag-skill-body', rows: 14, value: src.body, spellcheck: 'false', disabled: ro });
    const shared = h('input', { type: 'checkbox', class: 'switch', checked: !!e?.shared });
    const files = Object.entries(src.files).map(([p, t]) => ({ path: h('input', { value: p, spellcheck: 'false', disabled: ro }), text: h('textarea', { rows: 6, value: t, spellcheck: 'false', disabled: ro }) }));
    const fileBox = h('div', { class: 'ag-skill-files' });
    const err = h('div', { class: 'error-text' });
    const row = (label, el, hint) => h('div', { class: 'field col' }, h('label', {}, label), el, hint ? h('small', { class: 'faint' }, hint) : null);
    const paintFiles = () => fileBox.replaceChildren(
      ...files.map((f) => h('div', { class: 'ag-skill-file' },
        h('div', { class: 'ag-row' }, f.path,
          ro ? null : h('button', { class: 'icon-btn', type: 'button', title: '删掉这个文件', onclick: () => { files.splice(files.indexOf(f), 1); paintFiles(); } }, icon('trash', 14))),
        f.text)),
      ro ? null : h('button', {
        class: 'btn dashed small', type: 'button',
        onclick: () => {
          files.push({ path: h('input', { value: `refs/文件${files.length + 1}.md`, spellcheck: 'false' }), text: h('textarea', { rows: 6, spellcheck: 'false' }) });
          paintFiles();
        },
      }, icon('plus', 13), h('span', {}, '添加参考文件')));
    paintFiles();
    const box = h('div', { class: 'ag-form ag-skill-form' },
      ro ? h('p', { class: 'faint small' }, `管理员「${e.owner || ''}」共享的技能，只能查看。`) : null,
      row('名称', name, '输入框里打 /名称 可以点名使用'),
      row('什么时候用', desc, '助手平时只看到名称和这段说明，靠它判断该不该用，写清楚适用的请求'),
      row('做法（SKILL.md 正文）', body, '写给助手看的步骤，可以用 Markdown；可以写「需要时读 refs/xxx.md」让它按需读参考文件'),
      row('参考文件', fileBox, '比如画风列表、角色设定、TAG 表，只在需要时读取，不占平时的上下文'),
      !ro && deps.isAdmin() ? h('label', { class: 'switch-row' },
        h('div', {}, h('b', {}, '共享给所有人'), h('small', {}, '其他用户也能用这个技能（只能看，不能改）')), shared) : null,
      err);
    const save = () => {
      err.textContent = '';
      const n = name.value.trim();
      const d = desc.value.trim();
      if (!n || !d) return (err.textContent = '名称和「什么时候用」都要填');
      if (/[\n\r]/.test(n) || n.startsWith('/')) return (err.textContent = '名称不能换行，也不要以 / 开头');
      if (ownByName(n, e?.id)) return (err.textContent = `已经有叫「${n}」的技能了`);
      const out = { [MAIN]: composeSkill({ name: n, description: d, extra: src.extra, body: body.value }) };
      for (const f of files) {
        const p = cleanPath(f.path.value);
        if (!p || p === MAIN) return (err.textContent = `文件名「${f.path.value}」不对：用相对路径，比如 refs/styles.md`);
        if (p in out) return (err.textContent = `文件名「${p}」重复了`);
        out[p] = f.text.value;
      }
      const problem = parseSkill(out[MAIN]).error || checkFiles(out);
      if (problem) return (err.textContent = problem);
      if (!e && doc.data.skills.length >= MAX_SKILLS) return (err.textContent = `最多 ${MAX_SKILLS} 个技能`);
      const ok = mutate((dd) => {
        const s = { id: e?.id || uid(), enabled: e ? e.enabled : true, shared: deps.isAdmin() ? shared.checked : !!e?.shared, at: Date.now(), files: out };
        dd.skills = e ? dd.skills.map((x) => (x.id === e.id ? s : x)) : [...dd.skills, s];
      });
      if (!ok) return;
      toast(e ? '已保存' : '已添加', 'ok');
      closeForm();
      after();
    };
    const foot = ro
      ? [h('button', { class: 'btn ghost', type: 'button', onclick: () => exportSkill(e) }, '导出 zip'), h('button', { class: 'btn primary', type: 'button', onclick: () => closeForm() }, '关闭')]
      : [h('button', { class: 'btn ghost', type: 'button', onclick: () => closeForm() }, '取消'), h('button', { class: 'btn primary', type: 'button', onclick: save }, e ? '保存' : '添加')];
    const closeForm = deps.openModal({ title: ro ? '查看技能' : e ? '编辑技能' : '新建技能', body: box, foot, cls: 'ag-modal' });
    if (!ro) setTimeout(() => name.focus(), 30);
  }

  return {
    load() {
      if (doc.state === 'idle' || doc.state === 'error') doc.load();
      loadShared();
    },
    reset() {
      doc.reset();
      st.shared = [];
      st.sharedErr = '';
    },
    beacon: (k) => doc.beacon(k),
    active,
    catalogText,
    slash,
    suggest,
    section,
    tools: () => (active().length ? SKILL_TOOLS : []),
    run: { list_skills: () => listTool(), read_skill: (a) => readTool(a) },
  };
}
