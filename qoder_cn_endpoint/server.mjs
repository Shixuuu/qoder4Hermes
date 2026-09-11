#!/usr/bin/env node
/**
 * Loopback OpenAI-compatible facade for Qoder CN model transport.
 * Usage: node qoder_cn_endpoint/server.mjs [--port 8787] [--host 127.0.0.1]
 */
import http from "node:http";
import { completeChat, openaiModelList, buildSession } from "./cn_complete.mjs";
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

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
      send(res, 200, { ok: true, harness: "client", transport: "qoder-cn-gateway" });
      return;
    }
    if (req.method === "GET" && url === "/v1/models") {
      send(res, 200, openaiModelList());
      return;
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      const body = await readJson(req);
      const sess = await getSess();
      const out = await completeChat({
        messages: body.messages || [],
        model: body.model || "qwen3.8-max",
        sess,
      });
      delete out._debug;
      send(res, 200, out);
      return;
    }
    send(res, 404, { error: { message: `no ${req.method} ${url}` } });
  } catch (e) {
    send(res, 500, { error: { message: String(e.message || e) } });
  }
});

server.listen(port, host, () => {
  console.log(`qoder-cn inference facade http://${host}:${port}/v1`);
});
