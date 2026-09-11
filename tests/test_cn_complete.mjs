import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  completeChat,
  messagesToPrompt,
  parseSseAssistantText,
  resolveModelKey,
  openaiModelList,
} from "../qoder_cn_endpoint/cn_complete.mjs";
import { qoderDecode, CHAT_URL, MODEL_LIST_URL } from "../qoder_cn_endpoint/cn_cosy.mjs";
import { decryptCliUserFile } from "../qoder_cn_endpoint/cn_auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("shipped completion modules never spawn qoder CLI", () => {
  const files = [
    "qoder_cn_endpoint/cn_complete.mjs",
    "qoder_cn_endpoint/cn_auth.mjs",
    "qoder_cn_endpoint/cn_cosy.mjs",
    "qoder_cn_endpoint/server.mjs",
  ];
  for (const rel of files) {
    const src = readSrc(rel);
    assert.equal(src.includes("child_process"), false, rel);
    assert.equal(src.includes("spawn("), false, rel);
    assert.equal(src.includes("execFile"), false, rel);
    assert.equal(src.includes("execSync"), false, rel);
    for (const bin of ["qoderclicn", "qodercn", "qodercli"]) {
      assert.equal(
        new RegExp(String.raw`spawn\([^)]*${bin}`).test(src),
        false,
        `${rel} spawn ${bin}`
      );
    }
  }
  const joined = files.map(readSrc).join("\n");
  assert.match(joined, /gateway\.qoder\.com\.cn/);
  assert.match(joined, /agent_chat_generation/);
  assert.doesNotMatch(joined, /api\.qoder\.com\.cn\/api\/v1\/cloud/);
});

test("messagesToPrompt forwards system text", () => {
  const prompt = messagesToPrompt([
    { role: "system", content: "Your only output is the exact token QODER-INFER-PROBE" },
    { role: "user", content: "hi" },
  ]);
  assert.match(prompt, /QODER-INFER-PROBE/);
  assert.match(prompt, /SYSTEM INSTRUCTION/);
  assert.match(prompt, /USER:\nhi/);
});

test("completeChat posts to CN model transport and does not spawn CLI", async () => {
  const calls = [];
  async function fakeHttps(method, url, opts) {
    calls.push({ method, url, body: opts?.body || "" });
    if (url.includes("model/list")) {
      return {
        status: 200,
        body: JSON.stringify({
          chat: [{ key: "qmodel_38max", display_name: "Qwen3.8-Max", enable: true }],
        }),
      };
    }
    const inner = JSON.stringify({
      choices: [{ delta: { content: "ALPHA", role: "assistant" }, index: 0 }],
    });
    const sse = `data:${JSON.stringify({ body: inner, statusCodeValue: 200 })}\n\n`;
    return { status: 200, body: sse };
  }
  const sess = {
    cosyKey: "k",
    info: "aW5mbw==",
    identity: {
      uid: "u1",
      name: "n",
      user_type: "personal_standard",
      security_oauth_token: "jt-x",
      refresh_token: "jrt-x",
      aid: "u1",
    },
    machineId: "m".repeat(36),
    machineToken: "tok",
    machineType: "t",
  };
  const out = await completeChat({
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "Reply with the single word ALPHA and nothing else." },
    ],
    model: "qwen3.8-max",
    sess,
    httpsRequest: fakeHttps,
  });
  assert.equal(out.choices[0].message.content, "ALPHA");
  assert.equal(out.object, "chat.completion");
  const chatCall = calls.find((c) => c.method === "POST");
  assert.ok(chatCall, "expected POST");
  assert.equal(chatCall.url, CHAT_URL);
  const decoded = qoderDecode(chatCall.body).toString("utf8");
  assert.match(decoded, /be terse/);
  assert.match(decoded, /qmodel_38max/);
  assert.equal(decoded.includes("qoderclicn"), false);
});

test("parseSseAssistantText reads wrapper.body chunks", () => {
  const inner = JSON.stringify({
    choices: [{ delta: { content: "BRAVO" }, index: 0 }],
  });
  const sse = `data:${JSON.stringify({ body: inner, statusCodeValue: 200 })}\n`;
  assert.equal(parseSseAssistantText(sse), "BRAVO");
});

test("resolveModelKey maps qwen3.8-max", () => {
  assert.equal(resolveModelKey("qwen3.8-max"), "qmodel_38max");
  assert.equal(resolveModelKey("Qwen3.8-Max"), "qmodel_38max");
});

test("GET /v1/models catalog includes qwen3.8-max", () => {
  const list = openaiModelList();
  const ids = list.data.map((m) => m.id);
  assert.ok(ids.includes("qwen3.8-max"));
  assert.ok(ids.includes("Qwen3.8-Max"));
});

test("decryptCliUserFile is AES-128-CBC machine_id[:16]", async () => {
  const crypto = await import("node:crypto");
  const mid = "0123456789abcdef0123456789abcdef1234";
  const key = Buffer.from(mid.slice(0, 16), "utf8");
  const obj = { uid: "abc", personal_access_token: "pt-test", security_oauth_token: "jt-test" };
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  const blob = Buffer.concat([
    cipher.update(JSON.stringify(obj), "utf8"),
    cipher.final(),
  ]).toString("base64");
  const out = decryptCliUserFile(blob, mid);
  assert.equal(out.uid, "abc");
  assert.equal(out.personal_access_token, "pt-test");
});

test("model list URL is CN gateway not Cloud Agents", () => {
  assert.match(MODEL_LIST_URL, /gateway\.qoder\.com\.cn/);
  assert.equal(MODEL_LIST_URL.includes("api.qoder.com.cn/api/v1/cloud"), false);
});
