import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs } from "../bin/qoder-cn.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "qoder-cn.mjs");

test("parseArgs understands --yes and --json", () => {
  const a = parseArgs(["setup", "--yes", "--json", "--port", "8787"]);
  assert.equal(a.yes, true);
  assert.equal(a.json, true);
  assert.equal(a.port, 8787);
  assert.equal(a._[0], "setup");
});

test("qoder-cn help and version exit 0", () => {
  const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /qoder-cn setup/);
  assert.match(help.stdout, /--yes/);
  const ver = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /1\.0\.0/);
});
