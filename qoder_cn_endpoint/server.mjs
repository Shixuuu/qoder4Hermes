#!/usr/bin/env node
/**
 * Loopback OpenAI-compatible facade for Qoder CN model transport.
 * Usage: node qoder_cn_endpoint/server.mjs
 *
 * stream !== false → OpenAI SSE (Hermes default). stream:false → JSON.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeChat,
  openaiModelListLive,
  buildSession,
  streamOpenAiSse,
} from "./cn_complete.mjs";
import { resolveIdentity } from "./cn_auth.mjs";

const host = process.env.QODER_CN_INFER_HOST || "127.0.0.1";
const port = Number(process.env.QODER_CN_INFER_PORT || 8787);

let sessPromise = null;
function getSess() {
  if (!sessPromise) {
    sessPromise = resolveIdentity().then((id) =>
      buildSession(id.identity, id.machineId, id.machineToken, id.machineType)
    );
  }
  return sessPromise;
}

export function wantStream(body, req) {
  const s = body?.stream;
  if (s === false || s === "false" || s === 0) return false;
  if (s === true || s === "true" || s === 1) return true;
  const accept = String(req?.headers?.accept || "");
  if (accept.includes("text/event-stream")) return true;
  // Hermes streams even when the dumped body omits `stream`.
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function handleChatCompletions(req, res, body, sess, deps = {}) {
  if (!wantStream(body, req)) {
    const out = await completeChat({
      messages: body.messages || [],
      model: body.model || "qwen3.8-max",
      sess,
      tools: body.tools,
      tool_choice: body.tool_choice,
      reasoning_effort: body.reasoning_effort,
      extra: body.extra_body,
      httpsRequest: deps.httpsRequest,
      httpsStream: deps.httpsStream,
    });
    delete out._debug;
    send(res, 200, out);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.socket?.setNoDelay?.(true);
  try {
    for await (const ev of streamOpenAiSse({
      messages: body.messages || [],
      model: body.model || "qwen3.8-max",
      sess,
      tools: body.tools,
      tool_choice: body.tool_choice,
      reasoning_effort: body.reasoning_effort,
      extra: body.extra_body,
      httpsRequest: deps.httpsRequest,
      httpsStream: deps.httpsStream,
    })) {
      if (!res.write(ev)) {
        await new Promise((r) => res.once("drain", r));
      }
    }
  } catch (e) {
    const err = {
      id: "chatcmpl-error",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "qwen3.8-max",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      error: { message: String(e.message || e) },
    };
    res.write(`data: ${JSON.stringify(err)}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

/** Hermes with base_url http://127.0.0.1:8787 posts /chat/completions (no /v1). */
export function apiPath(urlPath) {
  const raw = String(urlPath || "").split("?")[0];
  if (raw === "/v1" || raw.startsWith("/v1/")) return raw.slice(3) || "/";
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const pathOnly = apiPath(url);
  try {
    if (req.method === "GET" && (pathOnly === "/health" || url === "/health")) {
      send(res, 200, { ok: true, harness: "client", transport: "qoder-cn-gateway" });
      return;
    }
    if (req.method === "GET" && pathOnly === "/models") {
      const sess = await getSess();
      send(res, 200, await openaiModelListLive(sess));
      return;
    }
    if (req.method === "POST" && pathOnly === "/chat/completions") {
      const body = await readJson(req);
      const sess = await getSess();
      await handleChatCompletions(req, res, body, sess);
      return;
    }
    send(res, 404, { error: { message: `no ${req.method} ${url}` } });
  } catch (e) {
    if (!res.headersSent) {
      send(res, 500, { error: { message: String(e.message || e) } });
    } else {
      res.end();
    }
  }
});

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // Hermes agent loops (tools + vision) can idle longer than Node's 5m default.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120000;
  server.listen(port, host, () => {
    console.log(`qoder-cn inference facade http://${host}:${port}/v1`);
  });
}

export { server, host, port };
