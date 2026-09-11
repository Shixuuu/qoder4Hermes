/**
 * One-turn CN model completion over HTTP/SSE. Does not start the Qoder CLI.
 */
import crypto from "node:crypto";
import { buildSession, CHAT_PATH, CHAT_URL, MODEL_LIST_URL, MODEL_LIST_PATH, cosyHeaders, defaultHttpsRequest, qoderEncode, qoderDecode } from "./cn_cosy.mjs";
import { resolveIdentity } from "./cn_auth.mjs";

export const MODEL_MAP = {
  auto: "auto",
  "qwen3.8-max": "qmodel_38max",
  "Qwen3.8-Max": "qmodel_38max",
  "qwen3.8-flash": "qfmodel",
  "Qwen3.8-Flash": "qfmodel",
  "qwen3.7-max": "qmodel_latest",
  "Qwen3.7-Max": "qmodel_latest",
  "qwen3.7-plus": "qmodel",
  "Qwen3.7-Plus": "qmodel",
  "qwen3.7-flash": "q37fmodel",
  "Qwen3.7-Flash": "q37fmodel",
  "deepseek-v4-pro": "dmodel",
  "DeepSeek-V4-Pro": "dmodel",
  "deepseek-flash": "dfmodel",
  "DeepSeek-Flash": "dfmodel",
  "glm-5.3": "gmodel",
  "GLM-5.3": "gmodel",
  "glm-5.3-flash": "gfmodel",
  "GLM-5.3-Flash": "gfmodel",
  "glm-5.2": "gm51model",
  "GLM-5.2": "gm51model",
  "kimi-k3": "kmodel_latest",
  "Kimi-K3": "kmodel_latest",
  "kimi-k2.7-code": "kmodel",
  "Kimi-K2.7-Code": "kmodel",
  "minimax-m2.7": "mmodel",
  "MiniMax-M2.7": "mmodel",
  qmodel_38max: "qmodel_38max",
};

export function resolveModelKey(modelId) {
  if (!modelId) return "qmodel_38max";
  return MODEL_MAP[modelId] || MODEL_MAP[String(modelId).toLowerCase()] || "qmodel_38max";
}

export const PUBLIC_MODEL_IDS = [
  "qwen3.8-max",
  "Qwen3.8-Max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "auto",
];

export function openaiModelList() {
  return {
    object: "list",
    data: PUBLIC_MODEL_IDS.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "qoder-cn",
      name: id,
    })),
  };
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

/**
 * Shipped completion entry: POST CN model transport, return OpenAI chat.completion.
 * `httpsRequest` is injectable for tests. Never starts a CLI subprocess.
 */
export async function completeChat(
  { messages, model = "qwen3.8-max", sess, httpsRequest = defaultHttpsRequest } = {}
) {
  if (!sess) {
    const id = await resolveIdentity(httpsRequest);
    sess = buildSession(id.identity, id.machineId, id.machineToken, id.machineType);
  }
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
  const res = await httpsRequest("POST", CHAT_URL, {
    headers,
    body,
    timeout: 180000,
  });
  if (res.status !== 200) {
    throw new Error(`chat HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  const content = parseSseAssistantText(res.body);
  return {
    id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _debug: { url: CHAT_URL, modelKey, prompt: messagesToPrompt(messages) },
  };
}

export { qoderDecode, CHAT_URL, MODEL_LIST_URL, buildSession };
