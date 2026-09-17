/**
 * One-turn CN model completion over HTTP/SSE. Does not start the Qoder CLI.
 */
import crypto from "node:crypto";
import {
  buildSession,
  CHAT_PATH,
  CHAT_URL,
  MODEL_LIST_URL,
  MODEL_LIST_PATH,
  cosyHeaders,
  defaultHttpsRequest,
  defaultHttpsStream,
  httpsStreamFromBuffered,
  qoderEncode,
  qoderDecode,
} from "./cn_cosy.mjs";
import { resolveIdentity } from "./cn_auth.mjs";
import { endpointsFor } from "./regions.mjs";
import {
  looksLikeToolMarkup,
  parseToolMarkup,
  openaiToolCallDeltas,
} from "./tools.mjs";
import {
  CHAT_FALLBACK,
  openaiListFromGateway,
  resolveModelKey as resolveFromCatalog,
} from "./catalog.mjs";
import { recordUsage } from "./usage_store.mjs";

const num0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Upstream usage events are forwarded as OpenAI usage chunks unless disabled. */
function usageChunksEnabled() {
  const v = String(process.env.QODER4HERMES_USAGE_CHUNKS ?? process.env.QODER_CN_INFER_USAGE_CHUNKS ?? "").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

export { CHAT_FALLBACK };
export function resolveModelKey(modelId) {
  return resolveFromCatalog(modelId);
}

export function openaiModelList(gateway) {
  return openaiListFromGateway(gateway || { chat: CHAT_FALLBACK });
}

export async function openaiModelListLive(sess, region = "cn") {
  if (!sess) return openaiModelList();
  try {
    const raw = await listRemoteModels(sess, undefined, region);
    return openaiListFromGateway(raw);
  } catch {
    return openaiModelList();
  }
}

export function normalizeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

export function extractImageParts(messages) {
  const images = [];
  for (const m of messages || []) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== "object") continue;
      const url =
        part.image_url?.url ||
        part.image_url ||
        (part.type === "image_url" && part.url) ||
        part.image ||
        "";
      if (part.type === "image_url" || part.type === "image" || url) {
        if (url) images.push({ type: "image_url", image_url: { url: String(url) } });
      }
    }
  }
  return images;
}

/** Fold client messages into the CN chat_context prompt so system text is visible to the model. */
export function messagesToPrompt(messages) {
  const parts = [];
  for (const m of messages || []) {
    const role = m?.role;
    const text = normalizeContent(m?.content);
    if (role === "system" && text) {
      parts.push(
        `SYSTEM INSTRUCTION (obey exactly, output nothing else):\n${text}`
      );
    } else if (role === "user" && text) {
      parts.push(`USER:\n${text}`);
    } else if (role === "assistant") {
      if (m.tool_calls?.length) {
        parts.push(`ASSISTANT TOOL CALLS:\n${JSON.stringify(m.tool_calls)}`);
      }
      if (text) parts.push(`ASSISTANT:\n${text}`);
    } else if (role === "tool" && text) {
      parts.push(`TOOL RESULT:\n${text}`);
    }
  }
  return parts.join("\n\n");
}

export function parseSseAssistantText(sseBody) {
  let content = "";
  for (const line of String(sseBody).split(/\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const wrapper = JSON.parse(line.slice(5).trim());
      const inner = JSON.parse(wrapper.body || "{}");
      for (const ch of inner.choices || []) {
        if (ch.delta?.content) content += ch.delta.content;
        if (ch.message?.content) content += ch.message.content;
      }
    } catch {
      /* skip non-JSON SSE lines */
    }
  }
  return content;
}

function mapUpstreamMessage(m) {
  const out = { role: m.role };
  if (Array.isArray(m.content)) out.content = m.content;
  else out.content = normalizeContent(m.content);
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

function applyClientOptions(body, { tools, tool_choice, reasoning_effort, extra }) {
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = tool_choice || "auto";
    const names = tools
      .map((t) => t?.function?.name || t?.name)
      .filter(Boolean);
    if (names.length) {
      const listing = names.join(", ");
      const note = `HERMES TOOLS (call these by exact name via tool_calls, never print XML): ${listing}`;
      if (body.chat_context?.text?.text) {
        body.chat_context.text.text = `${note}\n\n${body.chat_context.text.text}`;
      }
    }
  }
  if (reasoning_effort) {
    const on = !["none", "off", "minimal"].includes(String(reasoning_effort).toLowerCase());
    body.reasoning_effort = reasoning_effort;
    body.model_config.is_reasoning = on;
    if (body.chat_context?.extra?.modelConfig) {
      body.chat_context.extra.modelConfig.is_reasoning = on;
    }
  }
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && body[k] === undefined) body[k] = v;
    }
  }
  return body;
}

function buildChatBody({
  messages,
  modelKey,
  userType,
  tools,
  tool_choice,
  reasoning_effort,
  extra,
}) {
  const prompt = messagesToPrompt(messages);
  const lastUser = [...(messages || [])]
    .reverse()
    .find((m) => m.role === "user");
  const userText = normalizeContent(lastUser?.content) || prompt;
  const nid = crypto.randomUUID();
  const images = extractImageParts(messages);
  const body = {
    request_id: nid,
    request_set_id: crypto.randomUUID(),
    chat_record_id: nid,
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: false, key: modelKey },
        originalContent: { type: "text", text: prompt },
      },
      text: { type: "text", text: prompt },
    },
    session_id: crypto.randomUUID(),
    source: 1,
    version: "3",
    aliyun_user_type: userType || "personal_standard",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    model_config: {
      key: modelKey,
      is_vl: false,
      is_reasoning: false,
      source: "system",
    },
    messages: (messages || []).map(mapUpstreamMessage),
    business: {
      id: crypto.randomUUID(),
      name: userText.slice(0, 30) || "chat",
      begin_at: Date.now(),
    },
  };
  if (images.length) {
    body.model_config.is_vl = true;
    body.chat_context.extra.images = images;
    body.chat_context.extra.originalContent = {
      type: "multimodal",
      text: prompt,
      images,
    };
  }
  return applyClientOptions(body, { tools, tool_choice, reasoning_effort, extra });
}

export async function listRemoteModels(sess, httpsRequest = defaultHttpsRequest, region = "cn") {
  const date = String(Math.floor(Date.now() / 1000));
  const headers = cosyHeaders(sess, {
    date,
    body: "",
    pathWithoutAlgo: MODEL_LIST_PATH,
    accept: "application/json",
  });
  const res = await httpsRequest("GET", endpointsFor(region).modelListUrl, { headers, timeout: 20000 });
  if (res.status !== 200) {
    throw new Error(`model list HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return JSON.parse(res.body);
}

export function parseCnDataLine(payload) {
  try {
    const wrapper = JSON.parse(payload);
    if (wrapper.statusCodeValue && wrapper.statusCodeValue !== 200) {
      return { error: String(wrapper.body || wrapper.statusCode || "upstream error") };
    }
    const inner =
      typeof wrapper.body === "string" ? JSON.parse(wrapper.body || "{}") : wrapper.body || wrapper;
    const choice = (inner.choices || [])[0] || {};
    const delta = choice.delta || {};
    const finish = choice.finish_reason || null;
    if (inner.code && inner.code !== "ok") {
      return { error: inner.message || inner.code };
    }
    const out = {
      delta: {
        role: delta.role || undefined,
        content: typeof delta.content === "string" ? delta.content : "",
        tool_calls: delta.tool_calls,
      },
      finish_reason: finish,
    };
    // The CN gateway sends token + credit accounting as its own event right
    // before [DONE]: {choices:[], usage:{prompt_tokens, completion_tokens,
    // credits, original_credits, billable, ...}}.
    if (inner.usage && typeof inner.usage === "object") {
      const u = inner.usage;
      const usage = {
        prompt_tokens: num0(u.prompt_tokens),
        completion_tokens: num0(u.completion_tokens),
        total_tokens: num0(u.total_tokens),
        reasoning_tokens: num0(u.completion_tokens_details?.reasoning_tokens),
        cached_tokens: num0(u.prompt_tokens_details?.cached_tokens),
      };
      const credits = numOrNull(u.credits);
      if (credits !== null) usage.credits = credits;
      const original = numOrNull(u.original_credits);
      if (original !== null) usage.original_credits = original;
      if (typeof u.billable === "boolean") usage.billable = u.billable;
      out.usage = usage;
    }
    return out;
  } catch {
    return null;
  }
}

export function openAiSseChunk(id, created, model, delta, finishReason) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: delta || {},
          finish_reason: finishReason ?? null,
        },
      ],
    }) +
    "\n\n"
  );
}

/** OpenAI usage chunk (choices:[]) — same shape qoderclicn's OpenAI adapter emits. */
export function openAiUsageChunk(id, created, model, usage) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage,
    }) +
    "\n\n"
  );
}

function openAiUsagePayload(u) {
  const out = {
    prompt_tokens: num0(u.prompt_tokens),
    completion_tokens: num0(u.completion_tokens),
    total_tokens: num0(u.total_tokens),
    completion_tokens_details: { reasoning_tokens: num0(u.reasoning_tokens) },
    prompt_tokens_details: { cached_tokens: num0(u.cached_tokens) },
  };
  if (u.credits !== undefined) out.credits = u.credits;
  if (u.original_credits !== undefined) out.original_credits = u.original_credits;
  if (u.billable !== undefined) out.billable = u.billable;
  return out;
}

function resolveStreamFn({ httpsStream, httpsRequest }) {
  if (httpsStream) return httpsStream;
  if (httpsRequest) return httpsStreamFromBuffered(httpsRequest);
  return defaultHttpsStream;
}

function buildUpstreamPost({
  messages,
  model,
  sess,
  tools,
  tool_choice,
  reasoning_effort,
  extra,
}) {
  const modelKey = resolveModelKey(model);
  const chatObj = buildChatBody({
    messages,
    modelKey,
    userType: sess.identity.user_type,
    tools,
    tool_choice,
    reasoning_effort,
    extra,
  });
  const body = qoderEncode(JSON.stringify(chatObj));
  const date = String(Math.floor(Date.now() / 1000));
  const headers = {
    ...cosyHeaders(sess, {
      date,
      body,
      pathWithoutAlgo: CHAT_PATH,
      accept: "text/event-stream",
    }),
    "cache-control": "no-cache",
    "x-model-key": modelKey,
    "x-model-source": "system",
    "content-length": Buffer.byteLength(body),
  };
  return { body, headers, modelKey };
}

/**
 * Yield OpenAI SSE events (chunk lines + finish_reason + data: [DONE]).
 * Flushes CN gateway deltas as they arrive. Never starts a CLI subprocess.
 */
export async function* streamOpenAiSse({
  messages,
  model = "qwen3.8-max",
  sess,
  tools,
  tool_choice,
  reasoning_effort,
  extra,
  region = "cn",
  httpsStream,
  httpsRequest,
} = {}) {
  if (!sess) {
    const id = await resolveIdentity(httpsRequest || defaultHttpsRequest, { region });
    sess = buildSession(id.identity, id.machineId, id.machineToken, id.machineType);
  }
  const { body, headers } = buildUpstreamPost({
    messages,
    model,
    sess,
    tools,
    tool_choice,
    reasoning_effort,
    extra,
  });
  const streamFn = resolveStreamFn({ httpsStream, httpsRequest });
  const upstream = await streamFn("POST", endpointsFor(region).chatUrl, {
    headers,
    body,
    timeout: 600000,
  });
  if (upstream.status !== 200) {
    const bits = [];
    for await (const line of upstream.lines()) bits.push(line);
    throw new Error(`chat HTTP ${upstream.status}: ${bits.join("\n").slice(0, 300)}`);
  }
  const id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let sawFinish = false;
  let emittedToolCalls = false;
  let contentBuf = "";
  let finalUsage = null;
  const clientHasTools = Array.isArray(tools) && tools.length > 0;

  for await (const line of upstream.lines()) {
    if (!line.startsWith("data:")) continue;
    const parsed = parseCnDataLine(line.slice(5).trim());
    if (!parsed) continue;
    if (parsed.error) throw new Error(parsed.error);
    const delta = {};
    if (!sentRole) {
      delta.role = parsed.delta?.role || "assistant";
      sentRole = true;
    }
    if (parsed.delta?.tool_calls?.length) {
      delta.tool_calls = parsed.delta.tool_calls;
      emittedToolCalls = true;
    }
    const piece = parsed.delta?.content || "";
    if (piece) {
      const maybeMarkup = clientHasTools || looksLikeToolMarkup(contentBuf + piece);
      if (maybeMarkup) {
        contentBuf += piece;
      } else {
        delta.content = piece;
      }
    }
    const finish = parsed.finish_reason || null;
    if (finish === "tool_calls") {
      emittedToolCalls = true;
      sawFinish = true;
      yield openAiSseChunk(id, created, model, delta, "tool_calls");
      continue;
    }
    if (Object.keys(delta).length > 0) {
      yield openAiSseChunk(id, created, model, delta, null);
    }
    if (finish && finish !== "stop") {
      sawFinish = true;
      yield openAiSseChunk(id, created, model, {}, finish);
    }
    if (parsed.usage) {
      finalUsage = parsed.usage;
      if (usageChunksEnabled()) {
        yield openAiUsageChunk(id, created, model, openAiUsagePayload(parsed.usage));
      }
    }
  }

  // Account the turn locally (tokens + credits from the gateway's own event).
  if (finalUsage) {
    try {
      await recordUsage({ model, ...finalUsage });
    } catch {
      /* the meter is best-effort; never fail the completion over it */
    }
  }

  const markupCalls = parseToolMarkup(contentBuf);
  if (markupCalls.length) {
    if (!sentRole) {
      yield openAiSseChunk(id, created, model, { role: "assistant" }, null);
    }
    yield openAiSseChunk(
      id,
      created,
      model,
      { tool_calls: openaiToolCallDeltas(markupCalls) },
      null
    );
    yield openAiSseChunk(id, created, model, {}, "tool_calls");
  } else if (contentBuf) {
    yield openAiSseChunk(id, created, model, { content: contentBuf }, null);
    if (!sawFinish) yield openAiSseChunk(id, created, model, {}, "stop");
  } else if (emittedToolCalls) {
    if (!sawFinish) yield openAiSseChunk(id, created, model, {}, "tool_calls");
  } else if (!sawFinish) {
    yield openAiSseChunk(id, created, model, {}, "stop");
  }
  yield "data: [DONE]\n\n";
}

/**
 * Shipped non-stream completion: same transport as streamOpenAiSse, buffered JSON.
 */
export async function completeChat(
  {
    messages,
    model = "qwen3.8-max",
    sess,
    tools,
    tool_choice,
    reasoning_effort,
    extra,
    region = "cn",
    httpsRequest = defaultHttpsRequest,
    httpsStream,
  } = {}
) {
  let content = "";
  let finish = "stop";
  let id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  let created = Math.floor(Date.now() / 1000);
  let capturedUsage = null;
  const toolCalls = [];
  for await (const ev of streamOpenAiSse({
    messages,
    model,
    sess,
    tools,
    tool_choice,
    reasoning_effort,
    extra,
    region,
    httpsRequest,
    httpsStream,
  })) {
    const trimmed = ev.trim();
    if (trimmed === "data: [DONE]") continue;
    if (!trimmed.startsWith("data:")) continue;
    const obj = JSON.parse(trimmed.slice(5).trim());
    id = obj.id || id;
    created = obj.created || created;
    if (obj.usage) capturedUsage = obj.usage;
    const choice = (obj.choices || [])[0] || {};
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? toolCalls.length;
        if (!toolCalls[idx]) toolCalls[idx] = tc;
        else {
          const prev = toolCalls[idx];
          if (tc.function?.arguments) {
            prev.function = prev.function || {};
            prev.function.arguments =
              (prev.function.arguments || "") + tc.function.arguments;
          }
        }
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const message = { role: "assistant", content };
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish,
      },
    ],
    usage: capturedUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _debug: {
      url: endpointsFor(region).chatUrl,
      prompt: messagesToPrompt(messages),
      modelKey: resolveModelKey(model),
    },
  };
}

export { qoderDecode, CHAT_URL, MODEL_LIST_URL, buildSession };
