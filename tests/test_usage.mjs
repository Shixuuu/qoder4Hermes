/**
 * Usage/quota tests: normalization (mirrors qoderclicn), the local meter,
 * upstream usage-event handling, the /usage route, and Hermes profile wiring.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeQuotaUsage,
  fetchQuotaUsage,
  fetchUsagePresentation,
  fetchAccountUsage,
  formatResetIn,
  QUOTA_USAGE_URL,
} from "../qoder4hermes_endpoint/quota.mjs";
import {
  recordUsage,
  readUsage,
  usageSummary,
  formatCompact,
  flushUsage,
} from "../qoder4hermes_endpoint/usage_store.mjs";
import { completeChat, streamOpenAiSse } from "../qoder4hermes_endpoint/cn_complete.mjs";
import { handleUsage } from "../qoder4hermes_endpoint/server.mjs";
import {
  wireHermesAt,
  detectHermesProfiles,
  wireHermesProfiles,
  profileIsWired,
} from "../bin/qoder4hermes.mjs";

function tmpDir(prefix = "qci-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSess(extra = {}) {
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
      organization_id: "",
      ...extra,
    },
    machineId: "m".repeat(36),
    machineToken: "tok",
    machineType: "t",
  };
}

const QUOTA_FIXTURE = {
  userId: "u-1",
  userType: "personal_professional_trial",
  usageType: "credits",
  totalUsagePercentage: 0.3,
  isQuotaExceeded: false,
  expiresAt: 1789967681429,
  upgradeUrl: "https://qoder.com.cn/pricing?client=qoder",
  outerProviders: [],
  userQuota: { total: 300.0, used: 87.0, remaining: 213.0, percentage: 0.3, unit: "credits" },
  isPlanQuotaProrated: false,
};

test("normalizeQuotaUsage maps the live payload shape", () => {
  const out = normalizeQuotaUsage(QUOTA_FIXTURE);
  assert.equal(out.userId, "u-1");
  assert.equal(out.userType, "personal_professional_trial");
  assert.equal(out.usageType, "credits");
  assert.equal(out.totalUsagePercentage, 0.3);
  assert.equal(out.isQuotaExceeded, false);
  assert.equal(out.userQuota.used, 87);
  assert.equal(out.userQuota.total, 300);
  assert.equal(out.userQuota.remaining, 213);
  assert.equal(out.userQuota.unit, "credits");
  assert.equal(out.expiresAt, 1789967681429);
});

test("normalizeQuotaUsage handles camelCase, addOn, org package, dedicated rows", () => {
  const out = normalizeQuotaUsage({
    userId: "u",
    userType: "t",
    totalUsagePercentage: 1.4,
    isQuotaExceeded: true,
    addOnQuota: { total: 10, used: 2, detailUrl: "https://x" },
    orgResourcePackage: { used: 5, cap: 20, available: true },
    dedicatedResourcePackages: [{ id: "p1", name: "Seat", total: 100, used: 40 }],
  });
  assert.equal(out.totalUsagePercentage, 1); // clamped
  assert.equal(out.isQuotaExceeded, true);
  assert.equal(out.addOnQuota.remaining, 8);
  assert.equal(out.addOnQuota.detailUrl, "https://x");
  assert.equal(out.orgResourcePackage.cap, 20);
  assert.equal(out.dedicatedResourcePackages[0].id, "p1");
  assert.equal(out.dedicatedResourcePackages[0].remaining, 60);
});

test("normalizeQuotaUsage rejects payloads without identity fields", () => {
  assert.equal(normalizeQuotaUsage({ userQuota: { total: 1 } }), null);
  assert.equal(normalizeQuotaUsage(null), null);
});

test("fetchQuotaUsage uses Bearer auth and the CN openapi path", async () => {
  const calls = [];
  const httpsRequest = async (method, url, opts) => {
    calls.push({ method, url, headers: opts.headers });
    return { status: 200, body: JSON.stringify(QUOTA_FIXTURE) };
  };
  const out = await fetchQuotaUsage(makeSess(), httpsRequest);
  assert.equal(out.userQuota.used, 87);
  assert.equal(calls[0].url, QUOTA_USAGE_URL);
  assert.match(calls[0].url, /openapi\.qoder\.com\.cn\/api\/v2\/quota\/usage/);
  assert.equal(calls[0].headers.authorization, "Bearer jt-x");
});

test("fetchQuotaUsage surfaces 401 as an actionable error", async () => {
  const httpsRequest = async () => ({ status: 401, body: "denied" });
  await assert.rejects(fetchQuotaUsage(makeSess(), httpsRequest), /login expired/);
});

test("fetchUsagePresentation: personal account → qoder credits", async () => {
  const httpsRequest = async () => ({ status: 200, body: JSON.stringify(QUOTA_FIXTURE) });
  const out = await fetchUsagePresentation(makeSess(), httpsRequest);
  assert.equal(out.displayMode, "qoder");
  assert.equal(out.qoderUsage.userQuota.remaining, 213);
});

test("fetchUsagePresentation: org account prefers the presentation endpoint", async () => {
  const httpsRequest = async (m, url) => {
    if (url.includes("/sash/api/v2/me/usage")) {
      return {
        status: 200,
        body: JSON.stringify({ displayMode: "qoder", qoderUsage: QUOTA_FIXTURE }),
      };
    }
    throw new Error("should not be called");
  };
  const sess = makeSess({ organization_id: "org-1" });
  const out = await fetchUsagePresentation(sess, httpsRequest);
  assert.equal(out.displayMode, "qoder");
  assert.equal(out.qoderUsage.userQuota.used, 87);
});

test("fetchUsagePresentation: enterprise mode returns the console link", async () => {
  const httpsRequest = async () => ({
    status: 200,
    body: JSON.stringify({
      displayMode: "enterprise",
      enterpriseUsage: { openMode: "externalBrowser", detailUrl: "https://qoder.com.cn/enterprise" },
    }),
  });
  const sess = makeSess({ organization_id: "org-1" });
  const out = await fetchUsagePresentation(sess, httpsRequest);
  assert.equal(out.displayMode, "enterprise");
  assert.equal(out.enterpriseUsage.detailUrl, "https://qoder.com.cn/enterprise");
});

test("fetchAccountUsage tags fetchedAt", async () => {
  const httpsRequest = async () => ({ status: 200, body: JSON.stringify(QUOTA_FIXTURE) });
  const out = await fetchAccountUsage(makeSess(), httpsRequest);
  assert.ok(out.fetchedAt > 0);
});

test("formatResetIn renders days and hours", () => {
  const now = 1_789_000_000_000;
  assert.equal(formatResetIn(now + 4 * 86400000 + 23 * 3600000, now), "in 4d 23h");
  assert.equal(formatResetIn(now + 3 * 3600000 + 5 * 60000, now), "in 3h 5m");
  assert.equal(formatResetIn(0, now), "");
});

test("usage store records totals, models, and days (isolated dir)", async () => {
  const dir = tmpDir();
  process.env.QODER4HERMES_STATE_DIR = dir;
  try {
    await recordUsage({
      model: "qwen3.8-max",
      prompt_tokens: 63,
      completion_tokens: 13,
      total_tokens: 76,
      reasoning_tokens: 9,
      cached_tokens: 0,
      credits: 0.00189981,
      billable: true,
    });
    await recordUsage({
      model: "efficient",
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      credits: 0,
      billable: false,
    });
    await flushUsage();
    const u = readUsage();
    assert.equal(u.totals.requests, 2);
    assert.equal(u.totals.billable_requests, 1);
    assert.equal(u.totals.total_tokens, 88);
    assert.equal(u.totals.prompt_tokens, 73);
    assert.ok(Math.abs(u.totals.credits - 0.00189981) < 1e-9);
    assert.equal(u.models["qwen3.8-max"].total_tokens, 76);
    assert.equal(u.models.efficient.requests, 1);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(u.days[day].total_tokens, 88);
    const summary = usageSummary(u);
    assert.equal(summary.today.total_tokens, 88);
    assert.equal(summary.recent.length, 1);
    // corrupt file reads back as empty, never throws
    fs.writeFileSync(path.join(dir, "usage.json"), "{not json");
    assert.equal(readUsage().totals.requests, 0);
  } finally {
    delete process.env.QODER4HERMES_STATE_DIR;
  }
});

function usageSseLines() {
  const hello = JSON.stringify({
    choices: [{ delta: { role: "assistant", content: "HELLO" }, index: 0 }],
  });
  const usage = JSON.stringify({
    choices: [],
    usage: {
      billable: true,
      completion_tokens: 13,
      completion_tokens_details: { reasoning_tokens: 9 },
      credits: 0.00189981,
      original_credits: 0.00189981,
      prompt_tokens: 63,
      prompt_tokens_details: { cached_tokens: 0 },
      total_tokens: 76,
    },
  });
  return [
    `data:${JSON.stringify({ body: hello, statusCodeValue: 200 })}`,
    `data:${JSON.stringify({ body: usage, statusCodeValue: 200 })}`,
    `data:${JSON.stringify({ body: "[DONE]", statusCodeValue: 200 })}`,
  ];
}

async function fakeUsageStream() {
  const lines = usageSseLines();
  return {
    status: 200,
    async *lines() {
      for (const line of lines) yield line;
    },
  };
}

test("streamOpenAiSse forwards the upstream usage event as an OpenAI usage chunk", async () => {
  const dir = tmpDir();
  process.env.QODER4HERMES_STATE_DIR = dir;
  try {
    const events = [];
    for await (const ev of streamOpenAiSse({
      messages: [{ role: "user", content: "hi" }],
      model: "qwen3.8-max",
      sess: makeSess(),
      httpsStream: fakeUsageStream,
    })) {
      events.push(ev);
    }
    const usageEvent = events.find((ev) => ev.includes('"usage"') && ev.includes('"choices":[]'));
    assert.ok(usageEvent, "expected a usage chunk");
    const parsed = JSON.parse(usageEvent.replace(/^data: /, "").trim());
    assert.equal(parsed.choices.length, 0);
    assert.equal(parsed.usage.total_tokens, 76);
    assert.equal(parsed.usage.prompt_tokens, 63);
    assert.equal(parsed.usage.completion_tokens, 13);
    assert.equal(parsed.usage.completion_tokens_details.reasoning_tokens, 9);
    assert.ok(Math.abs(parsed.usage.credits - 0.00189981) < 1e-9);
    assert.equal(parsed.usage.billable, true);
    // still ends with [DONE]
    assert.equal(events[events.length - 1], "data: [DONE]\n\n");
    // and the meter recorded it
    await flushUsage();
    const u = readUsage();
    assert.equal(u.totals.requests, 1);
    assert.equal(u.totals.total_tokens, 76);
    assert.ok(Math.abs(u.totals.credits - 0.00189981) < 1e-9);
  } finally {
    delete process.env.QODER4HERMES_STATE_DIR;
  }
});

test("usage chunks can be disabled but the meter still records", async () => {
  const dir = tmpDir();
  process.env.QODER4HERMES_STATE_DIR = dir;
  process.env.QODER4HERMES_USAGE_CHUNKS = "0";
  try {
    const events = [];
    for await (const ev of streamOpenAiSse({
      messages: [{ role: "user", content: "hi" }],
      model: "qwen3.8-max",
      sess: makeSess(),
      httpsStream: fakeUsageStream,
    })) {
      events.push(ev);
    }
    assert.equal(events.some((ev) => ev.includes('"choices":[]')), false);
    await flushUsage();
    assert.equal(readUsage().totals.requests, 1);
  } finally {
    delete process.env.QODER4HERMES_USAGE_CHUNKS;
    delete process.env.QODER4HERMES_STATE_DIR;
  }
});

test("completeChat fills usage from the upstream event", async () => {
  const dir = tmpDir();
  process.env.QODER4HERMES_STATE_DIR = dir;
  try {
    async function fakeHttps() {
      return { status: 200, body: usageSseLines().join("\n") + "\n" };
    }
    const out = await completeChat({
      messages: [{ role: "user", content: "hi" }],
      model: "qwen3.8-max",
      sess: makeSess(),
      httpsRequest: fakeHttps,
    });
    assert.equal(out.choices[0].message.content, "HELLO");
    assert.equal(out.usage.total_tokens, 76);
    assert.equal(out.usage.prompt_tokens, 63);
  } finally {
    delete process.env.QODER4HERMES_STATE_DIR;
  }
});

test("handleUsage returns account + local and honors local=1", async () => {
  const dir = tmpDir();
  process.env.QODER4HERMES_STATE_DIR = dir;
  try {
    await recordUsage({ model: "qwen3.8-max", total_tokens: 5, credits: 0.1, billable: true });
    await flushUsage();
    const calls = [];
    const httpsRequest = async (m, url) => {
      calls.push(url);
      return { status: 200, body: JSON.stringify(QUOTA_FIXTURE) };
    };
    const res = fakeRes();
    await handleUsage({ url: "/usage?refresh=1" }, res, makeSess(), { httpsRequest });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.account.qoderUsage.userQuota.used, 87);
    assert.equal(body.source, "live");
    assert.equal(body.local.totals.requests, 1);

    const res2 = fakeRes();
    await handleUsage({ url: "/usage?local=1" }, res2, makeSess(), { httpsRequest });
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.account, null);
    assert.equal(body2.source, "local");
    assert.equal(calls.length, 1, "local=1 must not hit the Qoder API");
  } finally {
    delete process.env.QODER4HERMES_STATE_DIR;
  }
});

function fakeRes() {
  return {
    status: 0,
    body: "",
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(buf) {
      this.body = String(buf || "");
    },
  };
}

test("formatCompact renders token counts", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(45231), "45.2k");
  assert.equal(formatCompact(1_234_567), "1.23M");
});

test("wireHermesAt merges the provider without touching a profile's default model", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configPath,
    "model:\n  default: deepseek-v4.1-flash\n  provider: opencode-go\nfallback_providers: []\n"
  );
  const r = wireHermesAt({ host: "127.0.0.1", port: 8787 }, configPath);
  assert.equal(r.ok, true);
  const text = fs.readFileSync(configPath, "utf8");
  assert.match(text, /default: deepseek-v4\.1-flash/);
  assert.match(text, /provider: opencode-go/);
  assert.match(text, /qoder4hermes:/);
  assert.match(text, /base_url: http:\/\/127\.0\.0\.1:8787\/v1/);
  // Idempotent: wiring twice adds only one block.
  wireHermesAt({ host: "127.0.0.1", port: 8787 }, configPath);
  const text2 = fs.readFileSync(configPath, "utf8");
  assert.equal(text2.split("qoder4hermes:").length - 1, 1);
});

test("wireHermesAt refreshes an existing qoder base_url in place", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configPath,
    "providers:\n  qoder4hermes:\n    base_url: http://127.0.0.1:8787/v1\n"
  );
  wireHermesAt({ host: "127.0.0.1", port: 9999 }, configPath);
  const text = fs.readFileSync(configPath, "utf8");
  assert.match(text, /base_url: http:\/\/127\.0\.0\.1:9999\/v1/);
  assert.equal(profileIsWired(configPath), true);
});

test("wireHermesAt installs the /qoder + /claim quick commands idempotently", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(configPath, "model:\n  default: x\n");
  const r1 = wireHermesAt({ host: "127.0.0.1", port: 8787 }, configPath);
  assert.equal(r1.quick_command, true);
  const text1 = fs.readFileSync(configPath, "utf8");
  assert.match(text1, /quick_commands:/);
  assert.match(text1, /qoder4hermes usage --refresh/);
  assert.match(text1, /qoder4hermes claim/);
  // Idempotent: wiring twice keeps exactly one of each quick command.
  const r2 = wireHermesAt({ host: "127.0.0.1", port: 8787 }, configPath);
  assert.equal(r2.quick_command, false);
  const text2 = fs.readFileSync(configPath, "utf8");
  assert.equal(text2.split("qoder4hermes usage --refresh").length - 1, 1);
  assert.equal(text2.split("qoder4hermes claim").length - 1, 1);
});

test("pre-rename quick commands are recognized and not duplicated", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configPath,
    "quick_commands:\n  qoder:\n    type: exec\n    command: \"$HOME/.local/bin/qoder-cn-infer usage --refresh\"\n  claim:\n    type: exec\n    command: \"$HOME/.local/bin/qoder-cn-infer claim\"\n"
  );
  const r = wireHermesAt({ host: "127.0.0.1", port: 8787 }, configPath);
  const text = fs.readFileSync(configPath, "utf8");
  assert.equal(r.quick_command, false);
  assert.doesNotMatch(text, /qoder4hermes usage/);
});

test("wireHermesAt merges into an existing quick_commands map without dropping entries", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configPath,
    "quick_commands:\n  deploy:\n    type: alias\n    target: /new\n"
  );
  wireHermesAt({ host: "127.0.0.1", port: 8787 }, configPath);
  const text = fs.readFileSync(configPath, "utf8");
  assert.match(text, /deploy:/);
  assert.match(text, /\n  qoder:/);
  assert.match(text, /\n  claim:/);
  assert.equal(text.split("quick_commands:").length - 1, 1);
});

test("detectHermesProfiles finds profiles and wireHermesProfiles wires them", () => {
  const base = tmpDir("qci-profiles-");
  const kguDir = path.join(base, "kgu");
  fs.mkdirSync(kguDir);
  fs.writeFileSync(
    path.join(kguDir, "config.yaml"),
    "model:\n  default: deepseek-v4.1-flash\n  provider: opencode-go\n"
  );
  fs.writeFileSync(path.join(kguDir, ".env"), "X=1\n");
  const freshDir = path.join(base, "fresh");
  fs.mkdirSync(freshDir);
  fs.writeFileSync(path.join(freshDir, ".env"), "Y=1\n");
  fs.mkdirSync(path.join(base, "not-a-profile"), { recursive: true });

  process.env.QODER4HERMES_HERMES_PROFILES_DIR = base;
  try {
    const detected = detectHermesProfiles();
    assert.deepEqual(
      detected.map((p) => p.name),
      ["fresh", "kgu"]
    );
    assert.equal(detected.find((p) => p.name === "kgu").config_exists, true);
    assert.equal(detected.find((p) => p.name === "fresh").config_exists, false);

    const result = wireHermesProfiles({ host: "127.0.0.1", port: 8787 }, { all: true });
    const byName = Object.fromEntries(result.profiles.map((p) => [p.name, p]));
    assert.equal(byName.kgu.status, "wired");
    assert.equal(byName.fresh.status, "skipped_no_config");
    const kguText = fs.readFileSync(path.join(kguDir, "config.yaml"), "utf8");
    assert.match(kguText, /qoder4hermes:/);
    assert.match(kguText, /default: deepseek-v4\.1-flash/);
    assert.equal(fs.existsSync(path.join(freshDir, "config.yaml")), false);

    // Explicit names: unknown names are reported, not silently dropped.
    const named = wireHermesProfiles({ host: "127.0.0.1", port: 8787 }, { names: ["nope"] });
    assert.equal(named.profiles[0].status, "not_found");
  } finally {
    delete process.env.QODER4HERMES_HERMES_PROFILES_DIR;
  }
});
