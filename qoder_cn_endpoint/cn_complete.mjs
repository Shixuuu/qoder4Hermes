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
import {
  CHAT_FALLBACK,
  openaiListFromGateway,
  resolveModelKey as resolveFromCatalog,
} from "./catalog.mjs";

export { CHAT_FALLBACK };
export function resolveModelKey(modelId) {
  return resolveFromCatalog(modelId);
}

export function openaiModelList(gateway) {
  return openaiListFromGateway(gateway || { chat: CHAT_FALLBACK });
}

export async function openaiModelListLive(sess) {
  if (!sess) return openaiModelList();
  try {
    const raw = await listRemoteModels(sess);
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

/** Fold client messages into the CN chat_context prompt so system text is visible to the model. */
export function messagesToPrompt(messages) {
  const parts = [];
  for (const m of messages || []) {
    const role = m?.role;
    const text = normalizeContent(m?.content);
    if (!text) continue;
    if (role === "system") {
      parts.push(
        `SYSTEM INSTRUCTION (obey exactly, output nothing else):\n${text}`
      );
    } else if (role === "user") {
      parts.push(`USER:\n${text}`);
    } else if (role === "assistant") {
      parts.push(`ASSISTANT:\n${text}`);
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

function buildChatBody({ messages, modelKey, userType }) {
  const prompt = messagesToPrompt(messages);
  const lastUser = [...(messages || [])]
    .reverse()
    .find((m) => m.role === "user");
  const userText = normalizeContent(lastUser?.content) || prompt;
  const nid = crypto.randomUUID();
  return {
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
    messages: (messages || []).map((m) => ({
      role: m.role,
      content: normalizeContent(m.content),
    })),
    business: {
      id: crypto.randomUUID(),
      name: userText.slice(0, 30) || "chat",
      begin_at: Date.now(),
    },
  };
}

export async function listRemoteModels(sess, httpsRequest = defaultHttpsRequest) {
  const date = String(Math.floor(Date.now() / 1000));
  const headers = cosyHeaders(sess, {
    date,
    body: "",
    pathWithoutAlgo: MODEL_LIST_PATH,
    accept: "application/json",
  });
  const res = await httpsRequest("GET", MODEL_LIST_URL, { headers, timeout: 20000 });
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
    return {
      delta: {
        role: delta.role || undefined,
        content: typeof delta.content === "string" ? delta.content : "",
      },
      finish_reason: finish,
    };
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

function resolveStreamFn({ httpsStream, httpsRequest }) {
  if (httpsStream) return httpsStream;
  if (httpsRequest) return httpsStreamFromBuffered(httpsRequest);
  return defaultHttpsStream;
}

function buildUpstreamPost({ messages, model, sess }) {
  const modelKey = resolveModelKey(model);
  const chatObj = buildChatBody({
    messages,
    modelKey,
    userType: sess.identity.user_type,
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
  httpsStream,
  httpsRequest,
} = {}) {
  if (!sess) {
    const id = await resolveIdentity(httpsRequest || defaultHttpsRequest);
    sess = buildSession(id.identity, id.machineId, id.machineToken, id.machineType);
  }
  const { body, headers, modelKey } = buildUpstreamPost({ messages, model, sess });
  const streamFn = resolveStreamFn({ httpsStream, httpsRequest });
  const upstream = await streamFn("POST", CHAT_URL, {
    headers,
    body,
    timeout: 180000,
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
    if (parsed.delta?.content) delta.content = parsed.delta.content;
    const finish = parsed.finish_reason || null;
    if (Object.keys(delta).length > 0 || finish) {
      if (finish) sawFinish = true;
      yield openAiSseChunk(id, created, model, delta, finish);
    }
  }
  if (!sawFinish) {
    yield openAiSseChunk(id, created, model, {}, "stop");
  }
  yield "data: [DONE]\n\n";
}

/**
 * Shipped non-stream completion: same transport as streamOpenAiSse, buffered JSON.
 */
export async function completeChat(
  { messages, model = "qwen3.8-max", sess, httpsRequest = defaultHttpsRequest, httpsStream } = {}
) {
  let content = "";
  let finish = "stop";
  let id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  let created = Math.floor(Date.now() / 1000);
  for await (const ev of streamOpenAiSse({
    messages,
    model,
    sess,
    httpsRequest,
    httpsStream,
  })) {
    const trimmed = ev.trim();
    if (trimmed === "data: [DONE]") continue;
    if (!trimmed.startsWith("data:")) continue;
    const obj = JSON.parse(trimmed.slice(5).trim());
    id = obj.id || id;
    created = obj.created || created;
    const choice = (obj.choices || [])[0] || {};
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _debug: {
      url: CHAT_URL,
      prompt: messagesToPrompt(messages),
      modelKey: resolveModelKey(model),
    },
  };
}

export { qoderDecode, CHAT_URL, MODEL_LIST_URL, buildSession };
