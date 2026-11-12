// NovelAI 模型知识 + 请求体构造 + API 封装
// 能力表与请求格式参照 NAIWeaver / NekoAI-API 对 NAI 官方前端的抓取（2026-08）

export const MODELS = [
  { id: 'nai-diffusion-5-full', inpaint: 'nai-diffusion-5-full-inpainting', label: 'V5', sub: 'Full', v5: true, curated: false },
  // 官方前端暂时把 V5 Curated 的重绘路由到 V4.5 Curated inpainting
  { id: 'nai-diffusion-5-curated', inpaint: 'nai-diffusion-4-5-curated-inpainting', label: 'V5', sub: 'Curated', v5: true, curated: true },
  { id: 'nai-diffusion-4-5-full', inpaint: 'nai-diffusion-4-5-full-inpainting', label: 'V4.5', sub: 'Full', v5: false, curated: false },
  { id: 'nai-diffusion-4-5-curated', inpaint: 'nai-diffusion-4-5-curated-inpainting', label: 'V4.5', sub: 'Curated', v5: false, curated: true },
];

export const modelById = (id) => MODELS.find((m) => m.id === id) || MODELS[2];

const CAPS = {
  v45: { vibe: true, charRef: true, variety: true, noiseSchedule: true, transparency: false, autoText: false, maxCharacters: 6 },
  v5: { vibe: false, charRef: false, variety: false, noiseSchedule: false, transparency: true, autoText: true, maxCharacters: 32 },
};
export const capsOf = (model) => (model.v5 ? CAPS.v5 : CAPS.v45);

export const DEFAULTS = {
  v45: { steps: 23, scale: 5 },
  v5: { steps: 23, scale: 7 },
};

export const SAMPLERS = [
  ['k_euler_ancestral', 'Euler Ancestral'],
  ['k_euler', 'Euler'],
  ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
  ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
  ['k_dpmpp_2m', 'DPM++ 2M'],
  ['k_dpmpp_sde', 'DPM++ SDE'],
];

export const NOISE_SCHEDULES = ['karras', 'exponential', 'polyexponential'];

export const SIZES = [
  { label: '竖图', w: 832, h: 1216 },
  { label: '横图', w: 1216, h: 832 },
  { label: '方图', w: 1024, h: 1024 },
  { label: '大竖', w: 1024, h: 1536 },
  { label: '大横', w: 1536, h: 1024 },
  { label: '大方', w: 1472, h: 1472 },
  { label: '壁纸竖', w: 1088, h: 1920 },
  { label: '壁纸横', w: 1920, h: 1088 },
];

export const MAX_PIXELS = 3145728;
export const FREE_PIXELS = 1024 * 1024;

const UC_HEAVY = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
export const UC_PRESETS = [
  { id: 'heavy', label: '重度', text: UC_HEAVY },
  { id: 'light', label: '轻度', text: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::' },
  { id: 'human', label: '人物', text: `${UC_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy` },
  { id: 'furry', label: '兽人', text: '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic' },
  { id: 'none', label: '无', text: '' },
];

const qualitySuffix = (model) =>
  !model.v5 && model.curated
    ? 'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general'
    : 'very aesthetic, masterpiece, no text';

export const REF_TYPES = [
  ['character', '角色'],
  ['style', '风格'],
  ['character&style', '角色+风格'],
];

export const DIRECTOR_TOOLS = [
  { id: 'bg-removal', label: '去除背景' },
  { id: 'lineart', label: '提取线稿' },
  { id: 'sketch', label: '转为素描' },
  { id: 'colorize', label: '线稿上色', prompt: true, defry: true },
  { id: 'emotion', label: '修改表情', emotion: true },
  { id: 'declutter', label: '去除杂物' },
];

export const EMOTIONS = [
  ['neutral', '平静'], ['happy', '开心'], ['sad', '难过'], ['angry', '生气'], ['scared', '害怕'],
  ['surprised', '惊讶'], ['tired', '疲惫'], ['excited', '兴奋'], ['nervous', '紧张'], ['thinking', '思考'],
  ['confused', '困惑'], ['shy', '害羞'], ['disgusted', '嫌弃'], ['smug', '得意'], ['bored', '无聊'],
  ['laughing', '大笑'], ['irritated', '烦躁'], ['aroused', '兴奋（成人）'], ['embarrassed', '尴尬'],
  ['worried', '担心'], ['love', '爱慕'], ['determined', '坚定'], ['hurt', '受伤'], ['playful', '调皮'],
];

// ---------- 请求体 ----------

const clean = (s) => (s || '').replace(/\\/g, '').trim();

export function joinTags(a, b) {
  a = (a || '').trim();
  b = (b || '').trim();
  if (!a) return b;
  if (!b) return a;
  return a.replace(/[\s,]+$/, '') + ', ' + b;
}

// V5：提示词里引号包住的文字会被收集成 teXt: 块，和官网行为一致
function applyAutoText(prompt, extra) {
  if (/(?:^|[\n,])\s*text\s*:/i.test(prompt)) return prompt;
  const re = /"([^"\n]+)"|「([^」\n]+)」/g;
  const found = [];
  for (const src of [prompt, ...extra]) {
    for (const m of src.matchAll(re)) {
      const t = (m[1] ?? m[2] ?? '').trim();
      if (t) found.push(t);
    }
  }
  if (!found.length) return prompt;
  const trimmed = prompt.trimEnd();
  return `${trimmed}${trimmed.endsWith(',') ? ' ' : ', '}teXt: ${found.join('\n\n')}`;
}

export function actionOf(s) {
  if (!s.base) return 'generate';
  return s.base.mask ? 'infill' : 'img2img';
}

/**
 * 根据界面状态构造 /ai/generate-image 请求体。
 * vibes: [{ encoded, strength, info }]，已经过 encode-vibe 编码
 */
export function buildGenerateBody(s, { seed, vibes = [] }) {
  const model = modelById(s.modelId);
  const action = actionOf(s);
  // V5 Curated 的重绘实际打到 V4.5 Curated 模型上，请求体也要按 V4.5 构造
  const bodyModel = action === 'infill' && model.v5 && model.curated ? modelById('nai-diffusion-4-5-curated') : model;
  const caps = capsOf(bodyModel);

  const transparent = s.transparent && caps.transparency;
  const chars = s.characters
    .filter((c) => c.enabled && c.prompt.trim())
    .slice(0, caps.maxCharacters)
    .map((c) => ({ prompt: clean(c.prompt), uc: clean(c.negative), center: { x: c.x, y: c.y } }));

  let prompt = clean(s.prompt);
  let suffix = s.quality ? qualitySuffix(bodyModel) : '';
  if (transparent) suffix = joinTags('transparent background', suffix);
  prompt = joinTags(prompt, suffix);
  if (caps.autoText) prompt = applyAutoText(prompt, chars.map((c) => c.prompt));

  const preset = UC_PRESETS.find((p) => p.id === s.ucPreset);
  const negative = joinTags(preset ? preset.text : '', clean(s.negative));

  const sampler = s.sampler;
  const p = {
    params_version: bodyModel.v5 ? 4 : 3,
    width: s.width,
    height: s.height,
    scale: s.scale,
    sampler,
    steps: s.steps,
    seed,
    n_samples: s.nSamples,
    noise_schedule: caps.noiseSchedule && NOISE_SCHEDULES.includes(s.noiseSchedule) ? s.noiseSchedule : 'karras',
    dynamic_thresholding: false,
    cfg_rescale: s.cfgRescale,
    uc: negative,
    v4_prompt: {
      caption: { base_caption: prompt, char_captions: chars.map((c) => ({ char_caption: c.prompt, centers: [c.center] })) },
      use_coords: chars.length > 0 && !s.autoPosition,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: negative, char_captions: chars.map((c) => ({ char_caption: c.uc, centers: [c.center] })) },
      legacy_uc: false,
    },
  };
  if (!bodyModel.v5) {
    p.sm = false; // V4+ 发 true 会 500
    p.sm_dyn = false;
  }
  if (caps.variety) p.skip_cfg_above_sigma = s.variety ? 58 : null;
  if (chars.length) p.characterPrompts = chars.map((c) => ({ ...c, enabled: true }));
  if (bodyModel.v5 && sampler === 'k_euler_ancestral') {
    p.deliberate_euler_ancestral_bug = false;
    p.prefer_brownian = true;
  }
  if (transparent) {
    p.straight_alpha = true;
    p.tag_hint_transparent_background = true;
  }

  if (action !== 'generate') {
    p.image = s.base.b64;
    p.strength = s.base.strength;
    p.add_original_image = true;
  }
  if (action === 'img2img') {
    p.noise = s.base.noise;
    p.extra_noise_seed = seed;
  }
  if (action === 'infill') p.mask = s.base.mask;

  // 角色参考与 Vibe 互斥：两者都发会返回损坏的图片，与官网一致优先角色参考
  const refs = caps.charRef ? s.charRefs : [];
  if (refs.length) {
    p.director_reference_images = refs.map((r) => r.b64);
    p.director_reference_descriptions = refs.map((r) => ({ caption: { base_caption: r.type, char_captions: [] }, legacy_uc: false }));
    p.director_reference_strength_values = refs.map((r) => r.strength);
    p.director_reference_secondary_strength_values = refs.map((r) => +(1 - r.fidelity).toFixed(3)); // 接口上 fidelity 是反的
    p.director_reference_information_extracted = refs.map(() => 1);
  } else if (caps.vibe && vibes.length) {
    p.reference_image_multiple = vibes.map((v) => v.encoded);
    p.reference_strength_multiple = vibes.map((v) => v.strength);
    p.reference_information_extracted_multiple = vibes.map((v) => v.info);
    p.normalize_reference_strength_multiple = true;
  }

  return {
    input: prompt,
    model: action === 'infill' ? model.inpaint : model.id,
    action,
    parameters: p,
  };
}

// 价格公式取自官网前端（经 NAIWeaver 移植），不保证与实际扣费完全一致
// Opus 免费：单张、无底图、≤1024×1024、≤28 步；V5 改为消耗额度电池
// 角色参考每张 +5（Opus 也收），Vibe 超过 4 张后每张 +2
// ---------- 点数估算 ----------
// 公式照搬 NAI 官方前端（2026-11 的 novelai.net/image 打包代码），结果仍以实际扣费为准

const stepCost = (area, steps) => Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * steps);
const opusActive = (sub) => !!(sub?.isOpus && sub.active);
// V5 的免费张数走额度，额度用完（isNegative）就不再免费
const v5AllowanceOut = (sub) => !!sub?.usage?.isNegative;

export function estimateCost(s, sub) {
  const model = modelById(s.modelId);
  const caps = capsOf(model);
  const n = s.nSamples;
  const area = s.width * s.height;
  const strength = s.base && !s.base.mask ? s.base.strength : 1;
  let per = stepCost(area, s.steps);
  if (model.v5) per *= 1.5;
  per = Math.max(Math.ceil(per * strength), 2);
  const refs = caps.charRef ? s.charRefs.length : 0;
  const vibes = caps.vibe && !refs ? s.vibes.length : 0;
  const extra = refs * 5 * n + Math.max(0, vibes - 4) * 2;
  // Opus：1MP 以内、28 步以内、不带角色参考时，每批免掉一张
  const discount = opusActive(sub) && !refs && area <= FREE_PIXELS && s.steps <= 28 && !(model.v5 && v5AllowanceOut(sub));
  const paid = discount ? n - 1 : n;
  const base = per * paid;
  let kind = 'anlas';
  if (discount && paid === 0) kind = model.v5 ? 'allowance' : 'free';
  return { kind, base, extra, total: base + extra, per, discount };
}

const UPSCALE_TIERS = [[1048576, 1], [1747627, 2], [2446678, 3], [3145728, 4]];

/** 放大：只看原图像素数，不分会员等级；超出范围返回 null */
export function upscaleCost(w, h) {
  const area = w * h;
  for (const [limit, price] of UPSCALE_TIERS) if (area > 0 && area <= limit) return price;
  return null;
}

/**
 * 导演工具：按 V3 在 28 步的价格算。图先缩到 3MP 以内、再放到 1MP 左右；
 * Opus 在 1MP 以内免费，但去除背景一律收费（3 倍 + 5）。超出返回 null
 */
export function directorCost(tool, w, h, sub) {
  let area = w * h;
  if (!area) return null;
  if (area > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / area);
    [w, h] = [Math.floor(w * k), Math.floor(h * k)];
    area = w * h;
  }
  if (area < FREE_PIXELS) {
    const k = Math.sqrt(FREE_PIXELS / area);
    [w, h] = [Math.floor(w * k), Math.floor(h * k)];
    area = w * h;
  }
  const per = Math.max(stepCost(area, 28), 2);
  if (per > 140) return null;
  if (tool === 'bg-removal') return per * 3 + 5;
  return opusActive(sub) && area <= FREE_PIXELS ? 0 : per;
}

export const QUALITY_SUFFIXES = [
  'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'very aesthetic, masterpiece, no text',
  'very aesthetic, amazing quality, no text',
];

// ---------- API ----------

export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function createApi(getKey, onUnauthorized) {
  async function request(method, path, { json, signal, binary = false } = {}) {
    const headers = { Authorization: `Bearer ${getKey()}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined, signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError(0, '网络错误，连不上中转服务');
    }
    if (!res.ok) {
      let msg = res.statusText;
      let j = null;
      try {
        j = await res.json();
        msg = j.message || (typeof j.detail === 'string' ? j.detail : '') || msg;
      } catch {}
      if (res.status === 401 && msg === 'Invalid proxy key') onUnauthorized();
      throw new ApiError(res.status, explain(res.status, msg), j);
    }
    return binary ? new Uint8Array(await res.arrayBuffer()) : res.json();
  }
  return {
    me: () => request('GET', '/proxy/me'),
    subscription: () => request('GET', '/user/subscription'),
    generate: (body, signal) => request('POST', '/ai/generate-image', { json: body, signal, binary: true }),
    encodeVibe: (body, signal) => request('POST', '/ai/encode-vibe', { json: body, signal, binary: true }),
    augment: (body, signal) => request('POST', '/ai/augment-image', { json: body, signal, binary: true }),
    upscale: (body, signal) => request('POST', '/ai/upscale', { json: body, signal, binary: true }),
    suggestTags: (model, prompt, signal) =>
      request('GET', `/ai/generate-image/suggest-tags?model=${encodeURIComponent(model)}&prompt=${encodeURIComponent(prompt)}&lang=en`, { signal }),
    tagSearch: (q, cat, limit, signal) =>
      request('GET', `/proxy/tags/search?q=${encodeURIComponent(q)}${cat == null ? '' : `&cat=${cat}`}&limit=${limit}`, { signal }),
    tagLookup: (names) => request('POST', '/proxy/tags/lookup', { json: { names } }),
    tagDetail: (name) => request('GET', `/proxy/tags/detail?name=${encodeURIComponent(name)}`),
    userdataGet: (kind) => request('GET', `/proxy/userdata/${kind}`),
    userdataPut: (kind, rev, data) => request('PUT', `/proxy/userdata/${kind}`, { json: { rev, data } }),
  };
}

function explain(status, msg) {
  if (status === 401) return msg === 'Invalid proxy key' ? '访问密钥无效' : `NAI 鉴权失败：${msg}`;
  if (status === 402) return `Anlas 不足或订阅无效：${msg}`;
  if (status === 429) return `NAI 限流（可能有人在官网同时生成）：${msg}`;
  if (status === 503) return '排队超时，前面的生成还没结束';
  return `${status} ${msg}`;
}

export function parseSubscription(j) {
  if (!j || typeof j !== 'object') return null;
  let anlas = 0;
  const steps = j.trainingStepsLeft;
  if (typeof steps === 'number') anlas = steps;
  else if (steps && typeof steps === 'object') anlas = (steps.fixedTrainingStepsLeft || 0) + (steps.purchasedTrainingSteps || 0);
  const u = j.usage;
  return {
    tier: j.tier ?? 0,
    isOpus: (j.tier ?? 0) >= 3,
    active: !!j.active,
    anlas,
    usage: u && typeof u.percent === 'number' ? { percent: u.percent, isNegative: !!u.isNegative } : null,
  };
}

export const TIER_NAMES = ['Paper', 'Tablet', 'Scroll', 'Opus'];
