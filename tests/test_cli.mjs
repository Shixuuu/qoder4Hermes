import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs } from "../bin/qoder-cn-infer.mjs";

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
  assert.match(help.stdout, /--profiles/);
  assert.doesNotMatch(help.stdout, /^qoder-cn \[OPTIONS\]/m);
  assert.match(help.stdout, /--yes/);
  const ver = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /1\.1\.0/);
});
