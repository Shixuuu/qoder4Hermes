/**
 * CN chat-scene catalog: display names, gateway keys, credit multipliers.
 * Auto is the only CN routing pool (CLI Default tab). Named models are New Models.
 */
export const CHAT_FALLBACK = [
  { key: "auto", display_name: "Auto", price_factor: 0.5, is_default: true, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "qmodel_38max", display_name: "Qwen3.8-Max", price_factor: 0.5, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "qfmodel", display_name: "Qwen3.8-Flash", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "qmodel_latest", display_name: "Qwen3.7-Max", price_factor: 0.5, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "qmodel", display_name: "Qwen3.7-Plus", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "q37fmodel", display_name: "Qwen3.7-Flash", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "dmodel", display_name: "DeepSeek-V4-Pro", price_factor: 0.8, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0.2, is_reasoning: false, is_vl: true, max_input_tokens: 180000 },
  { key: "gmodel", display_name: "GLM-5.3", price_factor: 0.6, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "gfmodel", display_name: "GLM-5.3-Flash", price_factor: 0.1, is_reasoning: true, is_vl: true, max_input_tokens: 1000000 },
  { key: "gm51model", display_name: "GLM-5.2", price_factor: 0.6, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "kmodel_latest", display_name: "Kimi-K3", price_factor: 0.8, is_reasoning: false, is_vl: true, max_input_tokens: 180000 },
  { key: "kmodel", display_name: "Kimi-K2.7-Code", price_factor: 0.3, is_reasoning: true, is_vl: true, max_input_tokens: 180000 },
  { key: "mmodel", display_name: "MiniMax-M2.7", price_factor: 0.2, is_reasoning: false, is_vl: false, max_input_tokens: 180000 },
];

export function slugId(displayName) {
  return String(displayName || "")
    .trim()
    .toLowerCase();
}

export function formatRate(priceFactor) {
  if (priceFactor == null || Number.isNaN(Number(priceFactor))) return "";
  const n = Number(priceFactor);
  const text = Number.isInteger(n) ? String(n) : String(n);
  return `${text}x`;
}

export function displayLabel(row) {
  const rate = formatRate(row.price_factor);
  const isAuto = row.key === "auto" || slugId(row.display_name) === "auto";
  if (isAuto) return `Auto (routing · ${rate} credits)`;
  return `${row.display_name} (${rate} credits)`;
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
      max_input_tokens: m.max_input_tokens,
    });
  }
  return rows.length ? rows : CHAT_FALLBACK;
}

export function aliasMap(rows = CHAT_FALLBACK) {
  const map = Object.create(null);
  for (const row of rows) {
    map[row.key] = row.key;
    map[row.display_name] = row.key;
    map[slugId(row.display_name)] = row.key;
  }
  return map;
}

export function resolveModelKey(modelId, rows = CHAT_FALLBACK) {
  if (!modelId) return "qmodel_38max";
  const map = aliasMap(rows);
  return (
    map[modelId] ||
    map[String(modelId).toLowerCase()] ||
    map[slugId(modelId)] ||
    "qmodel_38max"
  );
}

/** One OpenAI /v1/models row per CN chat model (slug id). */
export function openaiListFromGateway(gateway) {
  const rows = normalizeChatRows(gateway);
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
      routing: row.key === "auto",
      reasoning: row.is_reasoning,
      vision: row.is_vl,
      context_length: row.max_input_tokens,
      qoder_key: row.key,
    });
    // Also accept the CN CLI display id (Qwen3.8-Max) if it differs from the slug.
    if (row.display_name && row.display_name !== id) {
      data.push({
        id: row.display_name,
        object: "model",
        created: 0,
        owned_by: "qoder-cn",
        name,
        display_name: row.display_name,
        price_factor: row.price_factor,
        rate: formatRate(row.price_factor),
        routing: row.key === "auto",
        reasoning: row.is_reasoning,
        vision: row.is_vl,
        context_length: row.max_input_tokens,
        qoder_key: row.key,
      });
    }
  }
  return { object: "list", data };
}

export function hermesModelsBlock(rows = CHAT_FALLBACK) {
  const models = {};
  for (const row of rows) {
    const id = slugId(row.display_name);
    models[id] = { name: displayLabel(row) };
  }
  return models;
}
