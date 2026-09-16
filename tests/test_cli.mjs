import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs, formatUsagePlain } from "../bin/qoder-cn-infer.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "qoder-cn-infer.mjs");

test("parseArgs understands --yes and --json", () => {
  const a = parseArgs(["setup", "--yes", "--json", "--port", "8787"]);
  assert.equal(a.yes, true);
  assert.equal(a.json, true);
  assert.equal(a.port, 8787);
  assert.equal(a._[0], "setup");
});

test("parseArgs collects profile flags and usage flags", () => {
  const a = parseArgs(["wire", "--profiles"]);
  assert.equal(a.allProfiles, true);
  const b = parseArgs(["wire", "--profile", "kgu", "--profile", "backend"]);
  assert.deepEqual(b.profiles, ["kgu", "backend"]);
  const c = parseArgs(["wire", "--profile=kgu,backend"]);
  assert.deepEqual(c.profiles, ["kgu", "backend"]);
  const d = parseArgs(["setup", "--no-profiles"]);
  assert.equal(d.noProfiles, true);
  const e = parseArgs(["usage", "--refresh", "--local"]);
  assert.equal(e.refresh, true);
  assert.equal(e.localOnly, true);
});

test("parseArgs collects telegram flags", () => {
  const a = parseArgs(["telegram", "--tg-token", "123:ABC", "--chat", "99", "--install"]);
  assert.equal(a.tgToken, "123:ABC");
  assert.equal(a.chat, "99");
  assert.equal(a.install, true);
  const b = parseArgs(["telegram", "--report"]);
  assert.equal(b.report, true);
  const c = parseArgs(["telegram", "--uninstall"]);
  assert.equal(c.uninstall, true);
  const d = parseArgs(["usage", "--plain"]);
  assert.equal(d.plain, true);
});

test("formatUsagePlain renders the compact chat summary", () => {
  const out = formatUsagePlain({
    account: {
      displayMode: "qoder",
      qoderUsage: {
        userType: "personal_professional_trial",
        totalUsagePercentage: 0.3,
        expiresAt: 1789967681429,
        isQuotaExceeded: false,
        userQuota: { used: 87, total: 300, remaining: 213, unit: "credits" },
      },
    },
    local: {
      totals: {
        requests: 4,
        prompt_tokens: 287,
        completion_tokens: 137,
        total_tokens: 424,
        reasoning_tokens: 119,
        credits: 0.0133,
      },
      today: { total_tokens: 424, credits: 0.0133 },
    },
    source: "live",
    endpoint: "http://127.0.0.1:8787/v1",
  });
  assert.match(out, /Qoder CN credits: 87\/300 used \(30\.0%\) · 213 credits remaining/);
  assert.match(out, /Resets .* · plan personal_professional_trial/);
  assert.match(out, /Local: 4 reqs · 424 tokens \(287 in \/ 137 out · 119 thinking\) · 0\.0133 credits/);
  assert.match(out, /API http:\/\/127\.0\.0\.1:8787\/v1 · source live/);
  // error / signed-out fallbacks
  assert.match(formatUsagePlain({ accountError: "quota HTTP 401" }), /Account: quota HTTP 401/);
  assert.match(formatUsagePlain({}), /not signed in/);
});

test("parseArgs login --browser and --pat --token", () => {
  const b = parseArgs(["login", "--browser"]);
  assert.equal(b.browser, true);
  assert.equal(b.pat, false);
  const p = parseArgs(["login", "--pat", "--token", "pt-example"]);
  assert.equal(p.pat, true);
  assert.equal(p.token, "pt-example");
});

test("qoder-cn-infer help and version exit 0", () => {
  const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /qoder-cn-infer setup/);
  assert.match(help.stdout, /usage/);
  assert.match(help.stdout, /claim/);
  assert.match(help.stdout, /--profiles/);
  assert.match(help.stdout, /telegram/);
  assert.doesNotMatch(help.stdout, /^qoder-cn \[OPTIONS\]/m);
  assert.match(help.stdout, /--yes/);
  const ver = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /1\.5\.0/);
});

test("CLI runs when invoked through the installed symlink shim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qci-link-"));
  try {
    const link = path.join(dir, "qoder-cn-infer");
    fs.symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link, "version", "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"version":\s*"\d+\.\d+\.\d+"/, "symlinked invocation must execute main()");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
