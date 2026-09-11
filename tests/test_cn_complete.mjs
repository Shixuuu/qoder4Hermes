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
  streamOpenAiSse,
} from "../qoder_cn_endpoint/cn_complete.mjs";
import { wantStream, handleChatCompletions, apiPath } from "../qoder_cn_endpoint/server.mjs";
import {
  openaiListFromGateway,
  formatRate,
  displayLabel,
  resolveModelKey as catalogResolve,
} from "../qoder_cn_endpoint/catalog.mjs";
import { qoderDecode, CHAT_URL, MODEL_LIST_URL } from "../qoder_cn_endpoint/cn_cosy.mjs";
import { decryptCliUserFile } from "../qoder_cn_endpoint/cn_auth.mjs";
import { parseDsmlToolCalls, parseToolMarkup } from "../qoder_cn_endpoint/tools.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("shipped completion modules never spawn qoder CLI", () => {
  const files = [
    "qoder_cn_endpoint/cn_complete.mjs",
    "qoder_cn_endpoint/cn_auth.mjs",
    "qoder_cn_endpoint/cn_cosy.mjs",
    "qoder_cn_endpoint/catalog.mjs",
    "qoder_cn_endpoint/tools.mjs",
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
  assert.equal(ids.includes("Qwen3.8-Max"), false);
  const keys = list.data.map((m) => m.qoder_key);
  assert.equal(keys.length, new Set(keys).size, "duplicate qoder_key in /v1/models");
});

test("catalog maps live chat rows to slugs, rates, and Auto routing", () => {
  const gateway = {
    chat: [
      { key: "auto", display_name: "Auto", enable: true, price_factor: 0.5, is_default: true },
      { key: "qfmodel", display_name: "Qwen3.8-Flash", enable: true, price_factor: 0.1 },
      { key: "dmodel", display_name: "DeepSeek-V4-Pro", enable: true, price_factor: 0.8 },
    ],
  };
  const list = openaiListFromGateway(gateway);
  const byId = Object.fromEntries(list.data.map((m) => [m.id, m]));
  assert.equal(formatRate(0.1), "0.1x");
  assert.equal(byId.auto.routing, true);
  assert.equal(byId.auto.rate, "0.5x");
  assert.match(byId.auto.name, /routing/);
  assert.equal(byId["qwen3.8-flash"].rate, "0.1x");
  assert.equal(byId["qwen3.8-flash"].price_factor, 0.1);
  assert.equal(byId["qwen3.8-flash"].qoder_key, "qfmodel");
  assert.equal(byId["Qwen3.8-Flash"], undefined);
  assert.equal(catalogResolve("qwen3.8-flash", gateway.chat), "qfmodel");
  assert.equal(catalogResolve("DeepSeek-V4-Pro", gateway.chat), "dmodel");
  assert.match(displayLabel(gateway.chat[1]), /0\.1x/);
});

test("resolveModelKey maps flash and glm rates aliases", () => {
  assert.equal(resolveModelKey("qwen3.8-flash"), "qfmodel");
  assert.equal(resolveModelKey("GLM-5.3-Flash"), "gfmodel");
  assert.equal(resolveModelKey("auto"), "auto");
});

test("routing tiers pass through as gateway keys", () => {
  // CN gateway rejects tier keys; CLI maps them onto Auto.
  assert.equal(resolveModelKey("efficient"), "auto");
  assert.equal(resolveModelKey("Performance"), "auto");
  assert.equal(resolveModelKey("lite"), "auto");
  assert.equal(resolveModelKey("ultimate"), "auto");
  const list = openaiModelList();
  const byId = Object.fromEntries(list.data.map((m) => [m.id, m]));
  assert.equal(byId.efficient.routing, true);
  assert.equal(byId.efficient.qoder_key, "efficient");
  assert.equal(byId.efficient.rate, "0x");
  assert.equal(byId.performance.routing, true);
  assert.equal(byId.performance.price_factor, 1.1);
  assert.equal(byId.lite.routing, true);
  assert.equal(byId.ultimate.price_factor, 1.6);
  assert.match(byId.efficient.name, /routing/);
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

test("apiPath accepts /chat/completions without /v1", () => {
  assert.equal(apiPath("/chat/completions"), "/chat/completions");
  assert.equal(apiPath("/v1/chat/completions"), "/chat/completions");
  assert.equal(apiPath("/v1/models"), "/models");
  assert.equal(apiPath("/models"), "/models");
});

test("wantStream defaults true (Hermes) and honors stream:false", () => {
  assert.equal(wantStream({}, { headers: {} }), true);
  assert.equal(wantStream({ stream: true }, { headers: {} }), true);
  assert.equal(wantStream({ stream: false }, { headers: {} }), false);
});

test("streamOpenAiSse emits content chunks, finish_reason, and [DONE]", async () => {
  const inner1 = JSON.stringify({
    choices: [{ delta: { role: "assistant", content: "" }, index: 0 }],
  });
  const inner2 = JSON.stringify({
    choices: [{ delta: { content: "HELLO" }, index: 0 }],
  });
  const cn = [
    `data:${JSON.stringify({ body: inner1, statusCodeValue: 200 })}`,
    `data:${JSON.stringify({ body: inner2, statusCodeValue: 200 })}`,
  ];
  async function fakeStream() {
    return {
      status: 200,
      async *lines() {
        for (const line of cn) yield line;
      },
    };
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
  const events = [];
  for await (const ev of streamOpenAiSse({
    messages: [{ role: "user", content: "hi" }],
    model: "qwen3.8-max",
    sess,
    httpsStream: fakeStream,
  })) {
    events.push(ev);
  }
  const joined = events.join("");
  assert.match(joined, /chat\.completion\.chunk/);
  assert.match(joined, /HELLO/);
  assert.match(joined, /"finish_reason":"stop"/);
  assert.match(joined, /data: \[DONE\]/);
  const lastChunk = events[events.length - 2];
  const parsed = JSON.parse(lastChunk.replace(/^data: /, "").trim());
  assert.equal(parsed.choices[0].finish_reason, "stop");
});

test("handleChatCompletions writes SSE for stream:true", async () => {
  const inner = JSON.stringify({
    choices: [{ delta: { content: "ZED", role: "assistant" }, index: 0 }],
  });
  const fakeSess = {
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
  async function httpsStream() {
    return {
      status: 200,
      async *lines() {
        yield `data:${JSON.stringify({ body: inner, statusCodeValue: 200 })}`;
      },
    };
  }
  const chunks = [];
  let headers = null;
  const res = {
    headersSent: false,
    writeHead(status, h) {
      this.status = status;
      headers = h;
      this.headersSent = true;
    },
    flushHeaders() {},
    socket: { setNoDelay() {} },
    write(d) {
      chunks.push(String(d));
      return true;
    },
    end() {
      this.ended = true;
    },
    once() {},
  };
  await handleChatCompletions(
    { headers: {} },
    res,
    { stream: true, model: "qwen3.8-max", messages: [{ role: "user", content: "hi" }] },
    fakeSess,
    { httpsStream }
  );
  const ctype = headers["Content-Type"] || headers["content-type"];
  assert.match(String(ctype), /text\/event-stream/);
  const body = chunks.join("");
  assert.match(body, /ZED/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(res.ended, true);
});

const SAMPLE_DSML = `<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="terminal"> <｜｜DSML｜｜ parameter name="command" string="true">ls -la "/home/shixu/Downloads/KXP_Testing_Docs_revised"</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> <｜｜DSML｜｜ invoke name="read_file"> <｜｜DSML｜｜ parameter name="path" string="true">/home/shixu/Downloads/KXP_Testing_Docs_revised/README.md</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>`;

test("parseDsmlToolCalls extracts Hermes tools from DSML markup", () => {
  const calls = parseDsmlToolCalls(SAMPLE_DSML);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, "terminal");
  assert.match(calls[0].function.arguments, /KXP_Testing_Docs_revised/);
  assert.equal(calls[1].function.name, "read_file");
  assert.match(calls[1].function.arguments, /README.md/);
});

test("streamOpenAiSse converts DSML content into OpenAI tool_calls", async () => {
  const inner = JSON.stringify({
    choices: [{ delta: { role: "assistant", content: SAMPLE_DSML }, index: 0 }],
  });
  async function httpsStream() {
    return {
      status: 200,
      async *lines() {
        yield `data:${JSON.stringify({ body: inner, statusCodeValue: 200 })}`;
      },
    };
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
  const events = [];
  for await (const ev of streamOpenAiSse({
    messages: [{ role: "user", content: "look at the screens" }],
    model: "qwen3.8-max",
    sess,
    tools: [{ type: "function", function: { name: "terminal" } }],
    httpsStream,
  })) {
    events.push(ev);
  }
  const joined = events.join("");
  assert.match(joined, /"tool_calls"/);
  assert.match(joined, /"name":"terminal"/);
  assert.match(joined, /"name":"read_file"/);
  assert.match(joined, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(joined, /DSML/);
});

test("completeChat forwards client tools in the CN body", async () => {
  const calls = [];
  async function fakeHttps(method, url, opts) {
    calls.push(opts?.body || "");
    const inner = JSON.stringify({
      choices: [{ delta: { content: "ok" }, index: 0 }],
    });
    return {
      status: 200,
      body: `data:${JSON.stringify({ body: inner, statusCodeValue: 200 })}\n`,
    };
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
  await completeChat({
    messages: [{ role: "user", content: "hi" }],
    model: "qwen3.8-max",
    sess,
    tools: [{ type: "function", function: { name: "read_file" } }],
    httpsRequest: fakeHttps,
  });
  const decoded = qoderDecode(calls[0]).toString("utf8");
  assert.match(decoded, /read_file/);
  assert.match(decoded, /"tools"/);
});

function fakeSess() {
  return {
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
}

function okSse() {
  const inner = JSON.stringify({
    choices: [{ delta: { content: "ok" }, index: 0 }],
  });
  return `data:${JSON.stringify({ body: inner, statusCodeValue: 200 })}\n`;
}

test("forwards Hermes tool catalog, reasoning, and tool-result turns", async () => {
  const captured = [];
  async function fakeHttps(method, url, opts) {
    captured.push(opts?.body || "");
    return { status: 200, body: okSse() };
  }
  const tools = [
    "terminal",
    "read_file",
    "write_file",
    "skill_view",
    "browser_exec",
    "web_search",
    "memory",
    "delegate_task",
    "execute_code",
  ].map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } }));
  await completeChat({
    messages: [
      { role: "system", content: "You are Hermes Agent." },
      { role: "user", content: "inspect the repo" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read_file",
        content: "# title",
      },
    ],
    model: "qwen3.8-max",
    sess: fakeSess(),
    tools,
    reasoning_effort: "medium",
    httpsRequest: fakeHttps,
  });
  const decoded = qoderDecode(captured[0]).toString("utf8");
  for (const name of ["terminal", "skill_view", "browser_exec", "delegate_task"]) {
    assert.match(decoded, new RegExp(name));
  }
  assert.match(decoded, /HERMES TOOLS/);
  assert.match(decoded, /reasoning_effort/);
  assert.match(decoded, /medium/);
  assert.match(decoded, /TOOL RESULT/);
  assert.match(decoded, /call_1/);
  assert.match(decoded, /is_reasoning":true/);
});
