#!/usr/bin/env node
/**
 * qoder-cn-infer — local OpenAI API for Qoder CN quota.
 * Not the official CLI (`qoderclicn` / `qodercn`).
 *
 *   qoder-cn-infer setup      # humans: walkthrough
 *   qoder-cn-infer setup -y   # agents: non-interactive
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  printBanner,
  printHeader,
  printInfo,
  printOk,
  printBad,
  printWarn,
  radioChoice,
  promptYesNo,
  readLine as wizardReadLine,
  ui,
} from "./wizard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VERSION = "1.0.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const CONFIG_DIR = path.join(os.homedir(), ".config", "qoder-cn-infer");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const STATE_DIR = path.join(os.homedir(), ".local", "state", "qoder-cn-infer");
const PID_PATH = path.join(STATE_DIR, "server.pid");
const LOG_PATH = path.join(STATE_DIR, "server.log");
const BIN_LINK = path.join(os.homedir(), ".local", "bin", "qoder-cn-infer");
const OLD_BIN_LINK = path.join(os.homedir(), ".local", "bin", "qoder-cn");
const UNIT_NAME = "qoder-cn-infer.service";
const UNIT_PATH = path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);

const tty = process.stdout.isTTY;
const wrap = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: (s) => wrap("1", s),
  dim: (s) => (tty ? `\x1b[38;2;161;161;170m${s}\x1b[0m` : s),
  mag: (s) => (tty ? `\x1b[38;2;196;132;252m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[38;2;125;211;252m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[38;2;52;211;153m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[38;2;251;113;133m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[38;2;251;191;36m${s}\x1b[0m` : s),
  fg: (s) => (tty ? `\x1b[38;2;228;228;231m${s}\x1b[0m` : s),
  ok: (s) => `${tty ? "\x1b[38;2;52;211;153m✔\x1b[0m" : "ok "} ${s}`,
  bad: (s) => `${tty ? "\x1b[38;2;251;113;133m✖\x1b[0m" : "err"} ${s}`,
  skip: (s) => `${tty ? "\x1b[38;2;161;161;170m○\x1b[0m" : ".. "} ${s}`,
};
const PAT_FILE = path.join(CONFIG_DIR, "pat");

function rule(width = 48) {
  return c.dim("─".repeat(width));
}

function banner(subtitle) {
  console.log("");
  console.log(`  ${c.bold(c.mag("qoder-cn-infer"))}  ${c.dim(VERSION)}`);
  console.log(`  ${rule()}`);
  if (subtitle) console.log(`  ${c.dim(subtitle)}`);
  console.log("");
}

function parseArgs(argv) {
  const args = {
    _: [],
    yes: false,
    json: false,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    help: false,
    browser: false,
    pat: false,
    token: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y" || a === "--yes" || a === "--non-interactive") args.yes = true;
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a === "--browser" || a === "--oauth") args.browser = true;
    else if (a === "--pat") args.pat = true;
    else if (a === "--token") args.token = argv[++i] || "";
    else if (a.startsWith("--token=")) args.token = a.slice(8);
    else if (a === "--host") args.host = argv[++i] || DEFAULT_HOST;
    else if (a === "--port") args.port = Number(argv[++i] || DEFAULT_PORT);
    else if (a.startsWith("--host=")) args.host = a.slice(7);
    else if (a.startsWith("--port=")) args.port = Number(a.slice(7));
    else if (!a.startsWith("-")) args._.push(a);
  }
  if (process.env.QODER_CN_YES === "1") args.yes = true;
  if (args.token) args.pat = true;
  return args;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { root: ROOT, host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function which(cmd) {
  const r = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(cmd)}`], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "";
}

function endpoint(cfg = loadConfig()) {
  const host = cfg.host || DEFAULT_HOST;
  const port = cfg.port || DEFAULT_PORT;
  return `http://${host}:${port}/v1`;
}

function printHelp() {
  const cmd = (name, desc) => `  ${c.mag(name.padEnd(12))} ${c.dim(desc)}`;
  banner("Local OpenAI API for your Qoder CN quota");
  console.log(`  ${c.dim("Not the official CLI")} ${c.fg("qoderclicn")} ${c.dim("/")} ${c.fg("qodercn")}`);
  console.log("");
  console.log(`  ${c.bold("Usage")}`);
  console.log(`    ${c.fg("qoder-cn-infer")} ${c.dim("[options]")} ${c.mag("<command>")}`);
  console.log("");
  console.log(`  ${c.bold("Commands")}`);
  console.log(cmd("setup", "Interactive onboarding wizard"));
  console.log(cmd("doctor", "Check Node, login, port, health"));
  console.log(cmd("login", "Sign in — browser or PAT"));
  console.log(cmd("logout", "Forget a stored PAT (CLI login kept)"));
  console.log(cmd("start", "Start the local API"));
  console.log(cmd("stop", "Stop the local API"));
  console.log(cmd("status", "Show endpoint and login"));
  console.log(cmd("models", "List models"));
  console.log(cmd("wire", "Write Hermes / OpenCode config"));
  console.log(cmd("uninstall", "Remove service and PATH shim"));
  console.log("");
  console.log(`  ${c.bold("Login")}`);
  console.log(`    ${c.mag("--browser")}              ${c.dim("qoderclicn login in the browser")}`);
  console.log(`    ${c.mag("--pat")}                  ${c.dim("paste / store a personal access token")}`);
  console.log(`    ${c.mag("--token")} ${c.dim("<pt-…>")}         ${c.dim("non-interactive PAT")}`);
  console.log("");
  console.log(`  ${c.bold("Options")}`);
  console.log(`    ${c.mag("-y, --yes")}              ${c.dim("no prompts (agents)")}`);
  console.log(`    ${c.mag("--json")}                 ${c.dim("machine-readable")}`);
  console.log(`    ${c.mag("--host --port")}          ${c.dim("bind address (default 127.0.0.1:8787)")}`);
  console.log("");
  console.log(`  ${c.bold("Walkthrough")}`);
  console.log(`    1  ${c.fg("qoder-cn-infer setup")}`);
  console.log(`    2  ${c.dim("Choose browser or PAT when asked")}`);
  console.log(`    3  ${c.dim("Point Hermes at")} ${c.cyan("http://127.0.0.1:8787/v1")}`);
  console.log("");
}

function jsonOut(obj) {
  console.log(JSON.stringify(obj));
}

function storedPat() {
  const env = (process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT || "").trim();
  if (env) return env;
  try {
    return fs.readFileSync(PAT_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function savePat(token) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PAT_FILE, token.trim() + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(PAT_FILE, 0o600);
  } catch {
    /* ignore */
  }
}

function hasLogin() {
  if (storedPat()) return true;
  const user = path.join(os.homedir(), ".qoder-cn", ".auth", "user");
  const mid = path.join(os.homedir(), ".qoder-cn", ".auth", "machine_id");
  try {
    return fs.statSync(user).size > 8 && fs.statSync(mid).size > 4;
  } catch {
    return false;
  }
}

function readLine(hidden = false) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (buf += d));
      stdin.on("end", () => resolve(buf.trim()));
      return;
    }
    if (hidden && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (s) => {
      if (s === "\u0003") process.exit(130);
      if (s === "\n" || s === "\r") {
        stdin.removeListener("data", onData);
        if (hidden && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(buf.trim());
        return;
      }
      if (s === "\u007f" || s === "\b") {
        buf = buf.slice(0, -1);
        return;
      }
      buf += s;
      if (!hidden) process.stdout.write(s);
    };
    stdin.on("data", onData);
  });
}

function httpGet(url, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout" });
    });
  });
}

async function isHealthy(cfg = loadConfig()) {
  const r = await httpGet(`http://${cfg.host || DEFAULT_HOST}:${cfg.port || DEFAULT_PORT}/health`);
  return r.status === 200;
}

function ensureDirs() {
  fs.mkdirSync(path.join(os.homedir(), ".local", "bin"), { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), ".config", "systemd", "user"), { recursive: true });
}

function linkCli() {
  ensureDirs();
  const src = path.join(ROOT, "bin", "qoder-cn-infer.mjs");
  try {
    fs.chmodSync(src, 0o755);
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(BIN_LINK) || fs.lstatSync(BIN_LINK).isSymbolicLink()) fs.unlinkSync(BIN_LINK);
  } catch {
    /* ignore */
  }
  try {
    fs.symlinkSync(src, BIN_LINK);
    return BIN_LINK;
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

function writeUnit(cfg) {
  const node = process.execPath;
  const server = path.join(ROOT, "qoder_cn_endpoint", "server.mjs");
  const unit = `[Unit]
Description=Qoder CN OpenAI-compatible inference facade
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=QODER_CN_INFER_HOST=${cfg.host || DEFAULT_HOST}
Environment=QODER_CN_INFER_PORT=${cfg.port || DEFAULT_PORT}
Environment=PATH=${path.dirname(node)}:/usr/bin:/bin
ExecStart=${node} ${server}
Restart=always
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(UNIT_PATH), { recursive: true });
  fs.writeFileSync(UNIT_PATH, unit);
}

function haveSystemdUser() {
  if (process.platform === "win32") return false;
  const r = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  return r.status === 0;
}

function startSystemd() {
  spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  const en = spawnSync("systemctl", ["--user", "enable", "--now", UNIT_NAME], { encoding: "utf8" });
  spawnSync("loginctl", ["enable-linger", os.userInfo().username], { encoding: "utf8" });
  return en.status === 0;
}

function stopSystemd() {
  spawnSync("systemctl", ["--user", "disable", "--now", UNIT_NAME], { encoding: "utf8" });
}

function startNohup(cfg) {
  ensureDirs();
  const node = process.execPath;
  const server = path.join(ROOT, "qoder_cn_endpoint", "server.mjs");
  const out = fs.openSync(LOG_PATH, "a");
  const child = spawn(node, [server], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      QODER_CN_INFER_HOST: String(cfg.host || DEFAULT_HOST),
      QODER_CN_INFER_PORT: String(cfg.port || DEFAULT_PORT),
    },
  });
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid));
  return child.pid;
}

function stopNohup() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    if (pid) process.kill(pid, "SIGTERM");
    fs.unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }
}

function ensureQoderCli(yes) {
  if (which("qoderclicn") || which("qodercn")) return { ok: true, path: which("qoderclicn") || which("qodercn") };
  const npm = which("npm");
  if (!npm) return { ok: false, error: "npm not found; install Node.js 18+" };
  const r = spawnSync(npm, ["install", "-g", "@qodercn-ai/qoderclicn"], {
    encoding: "utf8",
    timeout: 180000,
  });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || "npm install failed").slice(0, 400) };
  }
  return { ok: true, path: which("qoderclicn") || "qoderclicn", installed: true };
}

function waitEnter(yes, prompt) {
  if (yes) return;
  process.stdout.write(prompt);
  try {
    execFileSync("bash", ["-lc", "read -r _"], { stdio: "inherit" });
  } catch {
    /* ignore */
  }
}

function wireHermes(cfg) {
  const hermes = path.join(os.homedir(), ".hermes", "config.yaml");
  const block = `
  qoder-cn-infer:
    name: Qoder CN
    base_url: ${endpoint(cfg)}
    api_key: not-used
    transport: chat_completions
    discover_models: true
`.replace(/^\n/, "");
  if (!fs.existsSync(hermes)) {
    fs.mkdirSync(path.dirname(hermes), { recursive: true });
    fs.writeFileSync(
      hermes,
      `model:\n  default: qwen3.8-max\n  provider: qoder-cn-infer\nproviders:\n${block}`
    );
    return { ok: true, path: hermes, created: true };
  }
  let text = fs.readFileSync(hermes, "utf8");
  if (
    /^\s+qoder-cn-infer:/m.test(text) ||
    /^\s+qoder-cn:/m.test(text) ||
    /base_url:\s*http:\/\/127\.0\.0\.1:8787/m.test(text)
  ) {
    text = text.replace(/base_url:\s*http:\/\/127\.0\.0\.1:\d+(\/v1)?/g, `base_url: ${endpoint(cfg)}`);
    fs.writeFileSync(hermes, text);
    return { ok: true, path: hermes, updated: true };
  }
  if (/^providers:\s*$/m.test(text)) {
    text = text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
  } else if (/^providers:/m.test(text)) {
    text = text.replace(/^providers:\s*\n/m, `providers:\n${block}`);
  } else {
    text += `\nproviders:\n${block}`;
  }
  fs.writeFileSync(hermes, text);
  return { ok: true, path: hermes, updated: true };
}

function wireOpenCode(cfg) {
  const p = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  let obj = {};
  try {
    obj = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    obj = {};
  }
  obj.$schema = obj.$schema || "https://opencode.ai/config.json";
  obj.provider = obj.provider || {};
  obj.provider["qoder-cn-infer"] = {
    npm: "@ai-sdk/openai-compatible",
    name: "Qoder CN",
    options: { baseURL: endpoint(cfg), apiKey: "not-used" },
    models: {
      "qwen3.8-max": { name: "Qwen3.8-Max (0.5x credits)" },
      "qwen3.8-flash": { name: "Qwen3.8-Flash (0.1x credits)" },
      efficient: { name: "Efficient (routing · free)" },
      auto: { name: "Auto (routing · 0.5x credits)" },
    },
  };
  obj.model = obj.model || "qoder-cn-infer/qwen3.8-max";
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return { ok: true, path: p };
}

async function cmdDoctor(args) {
  const cfg = loadConfig();
  const checks = [];
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 18;
  checks.push({ id: "node", ok: nodeOk, detail: `v${process.versions.node}` });
  const cli = which("qoderclicn") || which("qodercn");
  checks.push({ id: "qoderclicn", ok: Boolean(cli), detail: cli || "not found" });
  const login = hasLogin();
  checks.push({ id: "login", ok: login, detail: login ? "signed in" : "not signed in" });
  const healthy = await isHealthy(cfg);
  checks.push({
    id: "api",
    ok: healthy,
    detail: healthy ? endpoint(cfg) : "not running",
  });
  if (args.json) {
    jsonOut({ ok: checks.every((x) => x.ok), checks, endpoint: endpoint(cfg) });
    return checks.every((x) => x.ok) ? 0 : 1;
  }
  printBanner("Doctor", "Node, Qoder login, and the local API.");
  for (const x of checks) {
    const line = `${x.id.padEnd(12)} ${c.dim(x.detail)}`;
    console.log("  " + (x.ok ? c.ok(line) : c.bad(line)));
  }
  console.log("");
  return checks.every((x) => x.ok) ? 0 : 1;
}

async function cmdStatus(args) {
  const cfg = loadConfig();
  const healthy = await isHealthy(cfg);
  const out = { running: healthy, endpoint: endpoint(cfg), login: hasLogin() };
  if (args.json) {
    jsonOut(out);
    return healthy ? 0 : 1;
  }
  console.log(healthy ? c.ok(`running  ${endpoint(cfg)}`) : c.bad("not running"));
  console.log(hasLogin() ? c.ok("login    signed in") : c.skip("login    missing (qoder-cn-infer login)"));
  return healthy ? 0 : 1;
}

async function cmdStart(args) {
  const cfg = { ...loadConfig(), host: args.host, port: args.port, root: ROOT };
  saveConfig(cfg);
  if (await isHealthy(cfg)) {
    if (args.json) jsonOut({ ok: true, already: true, endpoint: endpoint(cfg) });
    else console.log(c.ok(`already running  ${endpoint(cfg)}`));
    return 0;
  }
  if (!hasLogin()) {
    if (args.json) jsonOut({ ok: false, error: "not_logged_in" });
    else console.log(c.bad("not signed in. run  qoder-cn-infer login"));
    return 2;
  }
  writeUnit(cfg);
  let how = "nohup";
  if (haveSystemdUser() && startSystemd()) how = "systemd";
  else startNohup(cfg);
  for (let i = 0; i < 25; i++) {
    if (await isHealthy(cfg)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const ok = await isHealthy(cfg);
  if (args.json) jsonOut({ ok, how, endpoint: endpoint(cfg) });
  else console.log(ok ? c.ok(`started (${how})  ${endpoint(cfg)}`) : c.bad("failed to start — qoder-cn-infer doctor"));
  return ok ? 0 : 1;
}

async function cmdStop(args) {
  stopSystemd();
  stopNohup();
  if (args.json) jsonOut({ ok: true });
  else console.log(c.ok("stopped"));
  return 0;
}

async function chooseLoginMethod(args) {
  if (args.pat || args.token) return "pat";
  if (args.browser) return "browser";
  if (args.yes) {
    if (storedPat() || process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT) return "pat";
    return "browser";
  }
  const idx = await radioChoice(
    "How do you want to sign in?",
    [
      { label: "Browser", hint: "qoderclicn login · recommended" },
      { label: "PAT", hint: "token from qoder.cn/account/integrations" },
    ],
    0
  );
  return idx === 1 ? "pat" : "browser";
}

function loginBrowser(args) {
  const bin = which("qoderclicn") || which("qodercn");
  if (!bin) {
    if (args.json) jsonOut({ ok: false, error: "qoderclicn_missing" });
    else console.log("  " + c.bad("qoderclicn not installed — run  qoder-cn-infer setup"));
    return 1;
  }
  if (!args.json) {
    console.log("  " + c.dim("Opening the Qoder CN browser sign-in…"));
    console.log("  " + c.dim("If nothing opens:  qoderclicn login"));
    console.log("");
  }
  const r = spawnSync(bin, ["login"], { stdio: args.json ? "pipe" : "inherit" });
  const ok = hasLogin();
  if (args.json) jsonOut({ ok, method: "browser", status: r.status });
  else console.log("  " + (ok ? c.ok("signed in with browser") : c.skip("not detected yet — finish the page, then  qoder-cn-infer doctor")));
  return ok ? 0 : 2;
}

async function loginPat(args) {
  let token = (args.token || storedPat()).trim();
  if (!token && !args.yes) {
    printInfo("Create a token at  https://qoder.cn/account/integrations", null);
    token = await wizardReadLine({
      hidden: true,
      prompt: ui.yellow("  Paste PAT: "),
    });
  }
  if (!token) {
    if (args.json) jsonOut({ ok: false, error: "pat_missing" });
    else console.log("  " + c.bad("no token. set QODERCN_PERSONAL_ACCESS_TOKEN or pass --token"));
    return 2;
  }
  if (!/^pt-/.test(token) && token.length < 20) {
    if (args.json) jsonOut({ ok: false, error: "pat_invalid" });
    else console.log("  " + c.bad("that does not look like a Qoder PAT (usually starts with pt-)"));
    return 1;
  }
  savePat(token);
  process.env.QODERCN_PERSONAL_ACCESS_TOKEN = token;
  if (args.json) jsonOut({ ok: true, method: "pat" });
  else console.log("  " + c.ok("PAT stored in  ~/.config/qoder-cn-infer/pat  (mode 600)"));
  return 0;
}

async function cmdLogin(args) {
  if (!args.json && !args.fromSetup) {
    printBanner("Sign in", "Browser (qoderclicn login) or a personal access token.");
  }
  const method = await chooseLoginMethod(args);
  if (method === "pat") return loginPat(args);
  if (!which("qoderclicn") && !which("qodercn")) {
    const cli = ensureQoderCli(args.yes);
    if (!cli.ok) {
      if (args.json) jsonOut({ ok: false, error: "qoderclicn", detail: cli.error });
      else console.log("  " + c.bad(cli.error));
      return 1;
    }
  }
  return loginBrowser(args);
}

function cmdLogout(args) {
  try {
    fs.unlinkSync(PAT_FILE);
  } catch {
    /* ignore */
  }
  if (args.json) jsonOut({ ok: true });
  else {
    printBanner("Logout");
    console.log("  " + c.ok("stored PAT removed"));
    console.log("  " + c.dim("qoderclicn browser login was not touched"));
    console.log("");
  }
  return 0;
}

async function cmdModels(args) {
  const cfg = loadConfig();
  const r = await httpGet(`${endpoint(cfg)}/models`, 20000);
  if (r.status !== 200) {
    if (args.json) jsonOut({ ok: false, error: r.error || r.body });
    else console.log(c.bad("API not running. qoder-cn-infer start"));
    return 1;
  }
  const data = JSON.parse(r.body);
  if (args.json) jsonOut(data);
  else {
    for (const m of data.data || []) {
      const rate = m.rate ? c.dim(`  ${m.rate}`) : "";
      console.log(`${c.bold(m.id)}${rate}  ${m.name || ""}`);
    }
  }
  return 0;
}

function cmdWire(args) {
  const cfg = loadConfig();
  const h = wireHermes(cfg);
  const o = wireOpenCode(cfg);
  if (args.json) jsonOut({ hermes: h, opencode: o, endpoint: endpoint(cfg) });
  else {
    console.log(c.ok(`Hermes    ${h.path}`));
    console.log(c.ok(`OpenCode  ${o.path}`));
    console.log(c.dim(`Base URL  ${endpoint(cfg)}`));
    console.log(c.dim("API key   not-used"));
    console.log(c.dim("Model     qwen3.8-max"));
  }
  return 0;
}

async function cmdSetup(args) {
  const cfg = { root: ROOT, host: args.host, port: args.port };
  saveConfig(cfg);
  const report = { steps: [] };
  const step = (id, ok, detail) => {
    report.steps.push({ id, ok, detail });
    if (!args.json) (ok ? printOk : printBad)(`${id.padEnd(12)} ${ui.dim(detail)}`);
  };

  const interactive = !args.yes && !args.json && process.stdin.isTTY;
  if (!args.json) {
    printBanner(
      "qoder-cn-infer Setup Wizard",
      "Let's turn your Qoder CN quota into a local API.",
      "Press Ctrl+C at any time to exit."
    );
  }

  printHeader("Prerequisites");
  printInfo("Node, the CLI shim, and (for browser login) qoderclicn.");
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 18;
  step("node", nodeOk, `v${process.versions.node}`);
  if (!nodeOk) {
    if (args.json) jsonOut({ ok: false, error: "node_too_old", report });
    return 1;
  }

  const skipOfficialCli = Boolean(args.pat || args.token || storedPat());
  if (skipOfficialCli) {
    step("qoderclicn", true, "skipped · PAT login");
  } else {
    const cli = ensureQoderCli(args.yes);
    step("qoderclicn", cli.ok, cli.ok ? cli.path + (cli.installed ? " (installed)" : "") : cli.error);
    if (!cli.ok) {
      if (args.json) jsonOut({ ok: false, error: "qoderclicn", report });
      return 1;
    }
  }

  linkCli();
  step("cli", true, BIN_LINK);

  printHeader("Sign in");
  printInfo("This is the only step that needs your Qoder account.");
  if (!hasLogin()) {
    if (args.yes && !args.pat && !args.token && !args.browser) {
      if (args.json) {
        jsonOut({
          ok: false,
          error: "not_logged_in",
          hint: "qoder-cn-infer login --browser  or  --pat --token pt-…",
          report,
        });
      } else {
        printWarn("Sign in is required.");
        printInfo("Browser   qoder-cn-infer login --browser");
        printInfo("PAT       qoder-cn-infer login --pat --token pt-…");
        printInfo("Then      qoder-cn-infer setup --yes");
      }
      return 2;
    }
    const loginArgs = { ...args, json: false };
    if (interactive && !args.pat && !args.browser && !args.token) {
      loginArgs.pat = false;
      loginArgs.browser = false;
    }
    const loginCode = await cmdLogin({ ...loginArgs, json: false, fromSetup: true });
    if (loginCode !== 0 && !hasLogin()) {
      step("login", false, "still missing");
      return 2;
    }
  } else if (interactive) {
    printOk("Already signed in");
    const again = await promptYesNo("  Sign in again / switch method?", false);
    if (again) await cmdLogin({ ...args, json: false, fromSetup: true });
  }
  step("login", true, storedPat() ? "PAT" : "browser");

  printHeader("Local API");
  printInfo("Starts on 127.0.0.1 and restarts itself if it crashes.");
  const code = await cmdStart({ ...args, json: false });
  const healthy = await isHealthy(cfg);
  step("api", healthy, healthy ? endpoint(cfg) : "failed to start");
  if (!healthy) {
    if (args.json) jsonOut({ ok: false, error: "start_failed", report });
    return code || 1;
  }

  printHeader("Clients");
  let wireH = true;
  let wireO = true;
  if (interactive) {
    wireH = await promptYesNo("  Wire Hermes Agent (~/.hermes/config.yaml)?", true);
    wireO = await promptYesNo("  Wire OpenCode (~/.config/opencode/opencode.json)?", true);
  }
  const h = wireH ? wireHermes(cfg) : { path: "(skipped)" };
  const o = wireO ? wireOpenCode(cfg) : { path: "(skipped)" };
  if (wireH) printOk(`Hermes    ${h.path}`);
  else printInfo("Hermes skipped");
  if (wireO) printOk(`OpenCode  ${o.path}`);
  else printInfo("OpenCode skipped");
  step("clients", true, `wired → ${endpoint(cfg)}`);

  if (args.json) {
    jsonOut({
      ok: true,
      endpoint: endpoint(cfg),
      api_key: "not-used",
      model: "qwen3.8-max",
      hermes: h.path,
      opencode: o.path,
      report,
    });
  } else {
    console.log("");
    console.log(`  ${c.bold("Done")}`);
    console.log(`  ${rule()}`);
    console.log(`  ${c.dim("Base URL")}   ${c.cyan(endpoint(cfg))}`);
    console.log(`  ${c.dim("API key")}    ${c.fg("not-used")}`);
    console.log(`  ${c.dim("Model")}      ${c.fg("qwen3.8-max")}  ${c.dim("· qwen3.8-flash · efficient")}`);
    console.log("");
    console.log(`  ${c.dim("Hermes")}     hermes model  →  qoder-cn-infer / qwen3.8-max`);
    console.log("");
  }
  return 0;
}

function cmdUninstall(args) {
  stopSystemd();
  stopNohup();
  try {
    fs.unlinkSync(UNIT_PATH);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(BIN_LINK);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(OLD_BIN_LINK);
  } catch {
    /* ignore */
  }
  if (args.json) jsonOut({ ok: true });
  else console.log(c.ok("removed service and PATH shim. login files were left alone."));
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || (args.version ? "version" : args.help ? "help" : "help");
  if (cmd === "help" || args.help) {
    printHelp();
    return 0;
  }
  if (cmd === "version" || args.version) {
    if (args.json) jsonOut({ version: VERSION });
    else console.log(`qoder-cn-infer ${VERSION}`);
    return 0;
  }
  const table = {
    setup: cmdSetup,
    doctor: cmdDoctor,
    login: cmdLogin,
    logout: cmdLogout,
    start: cmdStart,
    stop: cmdStop,
    status: cmdStatus,
    models: cmdModels,
    wire: cmdWire,
    uninstall: cmdUninstall,
  };
  const fn = table[cmd];
  if (!fn) {
    console.error(`unknown command: ${cmd}`);
    printHelp();
    return 1;
  }
  return await fn(args);
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code ?? 0), (err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseArgs, hasLogin, endpoint, printHelp };
