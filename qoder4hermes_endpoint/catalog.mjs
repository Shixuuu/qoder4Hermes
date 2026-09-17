/**
 * CN chat-scene catalog: display names, gateway keys, credit multipliers.
 * Auto is the only CN routing pool (CLI Default tab). Named models are New Models.
 */
/**
 * CLI routing-tier ids (`NuA` in qoderclicn). CN's chat gateway rejects these
 * as model_config.key (invalid_model_error); the CLI still accepts
 * `--model efficient` etc. and bills them under the Auto pool. We expose the
 * picker ids and send `auto` upstream.
 */
export const TIER_GATEWAY_KEY = {
  auto: "auto",
  lite: "auto",
  efficient: "auto",
  performance: "auto",
  ultimate: "auto",
};

/**
 * CLI routing-tier ids (`NuA` in qoderclicn). Not all appear in --list-models.
 * max_input_tokens mirrors the operator policy: routing pools advertise 1M
 * (their routed models expose 400K/1M windows; see DEFAULT_CONTEXT_LENGTH).
 */
export const ROUTING_TIERS = [
  {
    key: "auto",
    display_name: "Auto",
    price_factor: 0.5,
    max_input_tokens: 1000000,
    blurb: "Smart routing: pick a model per turn",
  },
  {
    key: "lite",
    display_name: "Lite",
    price_factor: 0,
    max_input_tokens: 1000000,
    blurb: "Basic routing, free; slower at peak; no images",
  },
  {
    key: "efficient",
    display_name: "Efficient",
    price_factor: 0,
    max_input_tokens: 1000000,
    blurb: "Standard routing; free as of 2026-09-03 (was 0.3x)",
  },
  {
    key: "performance",
    display_name: "Performance",
    price_factor: 1.1,
    max_input_tokens: 1000000,
    blurb: "Advanced routing, high-quality output",
  },
  {
    key: "ultimate",
    display_name: "Ultimate",
    price_factor: 1.6,
    max_input_tokens: 1000000,
    blurb: "Peak routing / deepest reasoning",
  },
];

export const CHAT_FALLBACK = [
  { key: "auto", display_name: "Auto", price_factor: 0.5, is_default: true, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "qmodel_38max", display_name: "Qwen3.8-Max", price_factor: 0.5, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "qfmodel", display_name: "Qwen3.8-Flash", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "qmodel_latest", display_name: "Qwen3.7-Max", price_factor: 0.5, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "qmodel", display_name: "Qwen3.7-Plus", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "q37fmodel", display_name: "Qwen3.7-Flash", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "dmodel", display_name: "DeepSeek-V4-Pro", price_factor: 0.8, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0.2, is_reasoning: false, is_vl: true, max_input_tokens: 1000000 },
  { key: "gmodel", display_name: "GLM-5.3", price_factor: 0.6, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "gfmodel", display_name: "GLM-5.3-Flash", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "gm51model", display_name: "GLM-5.2", price_factor: 0.6, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "kmodel_latest", display_name: "Kimi-K3", price_factor: 0.8, is_reasoning: false, is_vl: true, max_input_tokens: 1000000 },
  { key: "kmodel", display_name: "Kimi-K2.7-Code", price_factor: 0.3, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "mmodel", display_name: "MiniMax-M2.7", price_factor: 0.2, is_reasoning: false, is_vl: false, max_input_tokens: 200000 },
];

/**
 * Operator policy (2026-09): advertise the platform's largest usable window as
 * `context_length`. Qoder's live model list exposes selectable context windows
 * per model (`context_config`: 200K default / 400K / 1M) while the legacy
 * `max_input_tokens` field is stale (180K, 96K) and must not cap harnesses.
 * Window choice is a client-side budgeting concern only (the CLI never sends it
 * in the chat request), so the largest window is safe to advertise.
 */
export const DEFAULT_CONTEXT_LENGTH = 1000000;

/** Parse a model row's selectable context windows (context_config or available_context_windows). */
export function parseContextWindows(row) {
  if (!row) return undefined;
  const cfg = row.context_config;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const nums = new Set();
    let def;
    for (const w of Object.values(cfg)) {
      const n = Number(w?.token_count);
      if (!Number.isInteger(n) || n <= 0) continue;
      nums.add(n);
      if (w?.is_default && def === undefined) def = n;
    }
    if (nums.size) {
      const windows = [...nums].sort((a, b) => a - b);
      return def !== undefined ? { windows, default: def } : { windows };
    }
  }
  const avail = row.available_context_windows ?? row.availableContextWindows;
  if (Array.isArray(avail)) {
    const nums = avail.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (nums.length) return { windows: [...new Set(nums)].sort((a, b) => a - b) };
  }
  return undefined;
}

/** The context length we advertise for a model: largest window, else the policy default. */
export function effectiveContextLength(row) {
  const parsed = parseContextWindows(row);
  if (parsed?.windows?.length) return Math.max(...parsed.windows);
  return DEFAULT_CONTEXT_LENGTH;
}

export function slugId(displayName) {
  return String(displayName || "")
    .trim()
    .toLowerCase();
}

export function formatRate(priceFactor) {
  if (priceFactor == null || Number.isNaN(Number(priceFactor))) return "";
  const n = Number(priceFactor);
  if (n === 0) return "0x";
  const text = Number.isInteger(n) ? String(n) : String(n);
  return `${text}x`;
}

export function displayLabel(row) {
  const rate = formatRate(row.price_factor);
  const free = Number(row.price_factor) === 0;
  const rateBit = free ? "free" : `${rate} credits`;
  if (row.routing || ROUTING_TIERS.some((t) => t.key === row.key)) {
    return `${row.display_name} (routing · ${rateBit})`;
  }
  return `${row.display_name} (${rateBit})`;
}

export function normalizeChatRows(gateway) {
  const raw = Array.isArray(gateway?.chat) ? gateway.chat : CHAT_FALLBACK;
  const rows = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || m.enable === false) continue;
    const key = String(m.key || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      display_name: m.display_name || key,
      price_factor: m.price_factor,
      is_default: Boolean(m.is_default),
      is_reasoning: Boolean(m.is_reasoning),
      is_vl: Boolean(m.is_vl),
      max_input_tokens: effectiveContextLength(m),
      context_windows: parseContextWindows(m),
    });
  }
  return rows.length ? rows : CHAT_FALLBACK;
}

export function mergedCatalogRows(gateway) {
  const chat = normalizeChatRows(gateway);
  const byKey = Object.fromEntries(chat.map((r) => [r.key, r]));
  const rows = [];
  const seen = new Set();
  for (const tier of ROUTING_TIERS) {
    const live = byKey[tier.key];
    rows.push({
      ...tier,
      ...(live || {}),
      key: tier.key,
      display_name: tier.display_name,
      price_factor: live?.price_factor ?? tier.price_factor,
      routing: true,
      blurb: tier.blurb,
    });
    seen.add(tier.key);
  }
  for (const row of chat) {
    if (seen.has(row.key)) continue;
    rows.push({ ...row, routing: false });
    seen.add(row.key);
  }
  return rows;
}

export function aliasMap(rows) {
  const map = Object.create(null);
  for (const row of rows || []) {
    map[row.key] = row.key;
    if (row.display_name) {
      map[row.display_name] = row.key;
      map[slugId(row.display_name)] = row.key;
    }
  }
  for (const tier of ROUTING_TIERS) {
    const gw = TIER_GATEWAY_KEY[tier.key] || "auto";
    map[tier.key] = gw;
    map[tier.display_name] = gw;
    map[slugId(tier.display_name)] = gw;
  }
  return map;
}

export function resolveModelKey(modelId, rows) {
  if (!modelId) return "auto";
  const map = aliasMap(rows || mergedCatalogRows({ chat: CHAT_FALLBACK }));
  const hit =
    map[modelId] || map[String(modelId).toLowerCase()] || map[slugId(modelId)];
  if (hit) return hit;
  return String(modelId);
}

/** One OpenAI /v1/models row per routing tier + CN chat model. */
export function openaiListFromGateway(gateway) {
  const rows = mergedCatalogRows(gateway);
  const data = [];
  for (const row of rows) {
    const id = slugId(row.display_name);
    const name = displayLabel(row);
    data.push({
      id,
      object: "model",
      created: 0,
      owned_by: "qoder-cn",
      name,
      display_name: row.display_name,
      price_factor: row.price_factor,
      rate: formatRate(row.price_factor),
      routing: Boolean(row.routing),
      reasoning: row.is_reasoning,
      vision: row.is_vl,
      context_length: row.max_input_tokens,
      ...(row.context_windows ? { context_windows: row.context_windows } : {}),
      qoder_key: row.key,
    });
  }
  return { object: "list", data };
}

export function hermesModelsBlock(rows) {
  const models = {};
  for (const row of rows || mergedCatalogRows({ chat: CHAT_FALLBACK })) {
    const id = slugId(row.display_name);
    models[id] = { name: displayLabel(row) };
  }
  return models;
}
