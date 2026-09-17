#!/usr/bin/env node
/**
 * Loopback OpenAI-compatible facade for Qoder CN model transport.
 * Usage: node qoder4hermes_endpoint/server.mjs
 *
 * stream !== false → OpenAI SSE (Hermes default). stream:false → JSON.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeChat,
  openaiModelListLive,
  buildSession,
  streamOpenAiSse,
} from "./cn_complete.mjs";
import { resolveIdentity } from "./cn_auth.mjs";
import { defaultHttpsRequest } from "./cn_cosy.mjs";
import { endpointsFor, resolveRegion } from "./regions.mjs";
import { fetchAccountUsage } from "./quota.mjs";
import { usageSummary } from "./usage_store.mjs";

const host = process.env.QODER4HERMES_HOST || process.env.QODER_CN_INFER_HOST || "127.0.0.1";
const port = Number(process.env.QODER4HERMES_PORT || process.env.QODER_CN_INFER_PORT || 8787);
// Region for this process: QODER4HERMES_REGION → config.json region → cn.
const region = resolveRegion();
const ep = endpointsFor(region);

let sessPromise = null;
function getSess() {
  if (!sessPromise) {
    sessPromise = resolveIdentity(defaultHttpsRequest, { region }).then((id) =>
      buildSession(id.identity, id.machineId, id.machineToken, id.machineType)
    );
  }
  return sessPromise;
}

function messageHasImage(messages) {
  for (const m of messages || []) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "image_url" || part.type === "image" || part.image_url) return true;
    }
  }
  return false;
}

export function wantStream(body, req) {
  const s = body?.stream;
  if (s === false || s === "false" || s === 0) return false;
  if (s === true || s === "true" || s === 1) return true;
  const accept = String(req?.headers?.accept || "");
  if (accept.includes("text/event-stream")) return true;
  if (accept.includes("application/json") && !accept.includes("event-stream")) return false;
  const tools = body?.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  // Hermes main chat omits `stream` but sends the tool catalog and consumes SSE.
  // vision_analyze omits `stream` too, has image parts and no tools, and parses JSON.
  if (messageHasImage(body?.messages) && !hasTools) return false;
  if (hasTools) return true;
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

const USAGE_CACHE_TTL_MS = Number(process.env.QODER4HERMES_USAGE_TTL_MS || process.env.QODER_CN_INFER_USAGE_TTL_MS || 60000);
const accountCache = { at: 0, value: null };

/**
 * GET /usage (also /v1/usage) — account quota (credits, reset, tokens policy)
 * plus the local meter of what this facade has served.
 *   ?refresh=1  bypass the 60s account cache
 *   ?local=1    skip the Qoder call entirely
 */
export async function handleUsage(req, res, sess, deps = {}) {
  const url = new URL(req.url || "/usage", "http://localhost");
  const refresh = url.searchParams.get("refresh") === "1";
  const localOnly = url.searchParams.get("local") === "1";
  const httpsRequest = deps.httpsRequest || defaultHttpsRequest;
  let account = null;
  let accountError = null;
  let source = "local";
  if (!localOnly) {
    const stale = refresh || Date.now() - accountCache.at > USAGE_CACHE_TTL_MS;
    if (!stale && accountCache.value) {
      account = accountCache.value;
      source = "cache";
    } else {
      try {
        account = await fetchAccountUsage(sess, httpsRequest, { region: deps.region ?? region });
        accountCache.at = Date.now();
        accountCache.value = account;
        source = "live";
      } catch (e) {
        accountError = String(e?.message || e);
        if (accountCache.value) {
          account = accountCache.value;
          source = "cache";
        }
      }
    }
  }
  send(res, 200, {
    ok: true,
    account,
    account_error: accountError,
    source,
    region,
    label: endpointsFor(deps.region ?? region).label,
    local: usageSummary(),
    fetched_at: Date.now(),
  });
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
      region: deps.region ?? region,
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
      region: deps.region ?? region,
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
      send(res, 200, {
        ok: true,
        harness: "client",
        transport: region === "global" ? "qoder-gateway" : "qoder-cn-gateway",
        region,
        label: ep.label,
      });
      return;
    }
    if (req.method === "GET" && pathOnly === "/models") {
      const sess = await getSess();
      send(res, 200, await openaiModelListLive(sess, region));
      return;
    }
    if (req.method === "GET" && pathOnly === "/usage") {
      const sess = await getSess();
      await handleUsage(req, res, sess, { region });
      return;
    }
    if (req.method === "POST" && pathOnly === "/chat/completions") {
      const body = await readJson(req);
      const sess = await getSess();
      await handleChatCompletions(req, res, body, sess, { region });
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

const isMain = (() => {
  // realpath-aware so a symlinked entry point still starts the server.
  try {
    const entry = process.argv[1]
      ? fs.realpathSync(path.resolve(process.argv[1]))
      : "";
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    if (entry && entry !== self && path.basename(entry) === path.basename(self)) {
      console.error(
        `[qoder4hermes] not starting: entry is ${entry} but module is ${self}`
      );
    }
    return Boolean(entry) && entry === self;
  } catch (e) {
    console.error(`[qoder4hermes] entry check failed: ${String(e?.message || e)}`);
    return false;
  }
})();

if (isMain) {
  // Hermes agent loops (tools + vision) can idle longer than Node's 5m default.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 120000;
  server.listen(port, host, () => {
    console.log(`qoder4hermes inference facade http://${host}:${port}/v1  ${ep.label} (region ${region})`);
  });
}

export { server, host, port };
