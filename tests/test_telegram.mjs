/**
 * Telegram usage-bot tests: command parsing, message rendering, chat binding,
 * polling, reporting, and token redaction — all against a scripted fetch.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createBot,
  parseCommand,
  renderUsageText,
  renderStatusText,
  tgCall,
  COMMANDS_HELP,
} from "../qoder4hermes_endpoint/telegram.mjs";

const USAGE_DATA = {
  account: {
    displayMode: "qoder",
    qoderUsage: {
      userType: "personal_professional_trial",
      totalUsagePercentage: 0.3,
      expiresAt: 1789967681429,
      isQuotaExceeded: false,
      userQuota: { total: 300, used: 87, remaining: 213, unit: "credits" },
    },
  },
  local: {
    totals: {
      requests: 4,
      prompt_tokens: 287,
      completion_tokens: 137,
      total_tokens: 424,
      reasoning_tokens: 119,
      cached_tokens: 0,
      credits: 0.0133,
    },
    today: { total_tokens: 424, credits: 0.0133 },
  },
  endpoint: "http://127.0.0.1:8787/v1",
};

function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: String(url).split("/").pop(), body });
    const next = script.shift();
    if (!next) throw new Error("no scripted response left");
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeBot({ state = {}, fetchImpl, collectUsage = async () => USAGE_DATA, persist } = {}) {
  return createBot({
    token: "123:ABC",
    state,
    persist: persist || (() => {}),
    collectUsage,
    collectStatus: async () => ({ running: true, login: true, endpoint: "http://127.0.0.1:8787/v1" }),
    fetchImpl,
  });
}

test("parseCommand understands /usage, @mentions, and bare words", () => {
  assert.equal(parseCommand("/usage"), "usage");
  assert.equal(parseCommand("/usage@QoderBot"), "usage");
  assert.equal(parseCommand("Usage"), "usage");
  assert.equal(parseCommand("/status"), "status");
  assert.equal(parseCommand("/start"), "start");
  assert.equal(parseCommand("/help"), "help");
  assert.equal(parseCommand("hello there"), null);
  assert.equal(parseCommand("/unknowncmd"), null);
});

test("renderUsageText includes credits, reset window, and the local meter", () => {
  const text = renderUsageText(USAGE_DATA);
  assert.match(text, /87 \/ 300 used \(30\.0%\)/);
  assert.match(text, /Remaining: 213 credits/);
  assert.match(text, /Resets:/);
  assert.match(text, /4 requests · 424 tokens \(287 in \/ 137 out\)/);
  assert.match(text, /0\.0133 credits/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8787\/v1/);
});

test("renderUsageText reports errors and missing login", () => {
  assert.match(
    renderUsageText({ account: null, account_error: "quota HTTP 401", local: null }),
    /quota HTTP 401/
  );
  assert.match(renderUsageText({ account: null, local: null }), /not signed in/);
});

test("renderStatusText shows API and login state", () => {
  const text = renderStatusText({ running: true, login: false }, { endpoint: "http://x/v1" });
  assert.match(text, /API: running/);
  assert.match(text, /Login: missing/);
});

test("bot binds the first chat, then answers /usage with real numbers", async () => {
  const state = {};
  let persisted = 0;
  const fetchImpl = scriptedFetch([
    { ok: true, result: [{ update_id: 10, message: { text: "/start", chat: { id: 99 }, from: { username: "s" } } }] },
    { ok: true, result: {} },
    { ok: true, result: [{ update_id: 11, message: { text: "/usage", chat: { id: 99 } } }] },
    { ok: true, result: {} },
  ]);
  const bot = makeBot({ state, fetchImpl, persist: () => persisted++ });
  assert.equal(await bot.pollOnce(), 1);
  assert.equal(state.chat_id, 99);
  assert.equal(state.offset, 11);
  assert.equal(await bot.pollOnce(), 1);
  assert.equal(state.offset, 12);
  assert.equal(persisted, 2);

  const sends = fetchImpl.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.match(sends[0].body.text, /Bound to this chat/);
  assert.match(sends[1].body.text, /87 \/ 300 used/);
  assert.equal(sends[1].body.chat_id, 99);
  assert.equal(sends[1].body.parse_mode, "HTML");

  const polls = fetchImpl.calls.filter((c) => c.method === "getUpdates");
  assert.equal(polls[1].body.offset, 11, "offset must advance past processed updates");
});

test("messages from unbound chats are ignored", async () => {
  const state = { chat_id: 99, offset: 0 };
  const fetchImpl = scriptedFetch([
    { ok: true, result: [{ update_id: 5, message: { text: "/usage", chat: { id: 7 } } }] },
  ]);
  const bot = makeBot({ state, fetchImpl });
  await bot.pollOnce();
  assert.equal(fetchImpl.calls.filter((c) => c.method === "sendMessage").length, 0);
  assert.equal(state.offset, 6);
});

test("unknown text in a bound chat gets the command hint", async () => {
  const fetchImpl = scriptedFetch([
    { ok: true, result: [{ update_id: 3, message: { text: "hi", chat: { id: 99 } } }] },
    { ok: true, result: {} },
  ]);
  const bot = makeBot({ state: { chat_id: 99 }, fetchImpl });
  await bot.pollOnce();
  const send = fetchImpl.calls.find((c) => c.method === "sendMessage");
  assert.equal(send.body.text, COMMANDS_HELP);
});

test("sendReport pushes to the bound chat and refuses when unbound", async () => {
  const fetchImpl = scriptedFetch([{ ok: true, result: {} }]);
  const bot = makeBot({ state: { chat_id: 42 }, fetchImpl });
  const chatId = await bot.sendReport();
  assert.equal(chatId, 42);
  assert.equal(fetchImpl.calls[0].method, "sendMessage");
  assert.equal(fetchImpl.calls[0].body.chat_id, 42);
  assert.match(fetchImpl.calls[0].body.text, /Qoder CN usage/);

  const naked = makeBot({ state: {}, fetchImpl: scriptedFetch([]) });
  await assert.rejects(naked.sendReport(), /no chat bound/);
});

test("tgCall never leaks the bot token in error messages", async () => {
  const token = "123:SUPERSECRET";
  const fetchImpl = async () => {
    throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${token}/getUpdates`);
  };
  await assert.rejects(
    tgCall(token, "getUpdates", {}, fetchImpl),
    (e) => !e.message.includes("SUPERSECRET") && e.message.includes("***")
  );
});

test("tgCall surfaces Bot API failures with their description", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 401,
    json: async () => ({ ok: false, description: "Unauthorized" }),
  });
  await assert.rejects(tgCall("t", "sendMessage", {}, fetchImpl), /Unauthorized/);
});
