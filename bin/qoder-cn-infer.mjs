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
const c = {
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  ok: (s) => (tty ? `\x1b[32m✓\x1b[0m ${s}` : `ok  ${s}`),
  bad: (s) => (tty ? `\x1b[31m✗\x1b[0m ${s}` : `err ${s}`),
  skip: (s) => (tty ? `\x1b[33m•\x1b[0m ${s}` : `..  ${s}`),
};

function parseArgs(argv) {
  const args = { _: [], yes: false, json: false, host: DEFAULT_HOST, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y" || a === "--yes" || a === "--non-interactive") args.yes = true;
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a === "--host") args.host = argv[++i] || DEFAULT_HOST;
    else if (a === "--port") args.port = Number(argv[++i] || DEFAULT_PORT);
    else if (a.startsWith("--host=")) args.host = a.slice(7);
    else if (a.startsWith("--port=")) args.port = Number(a.slice(7));
    else if (!a.startsWith("-")) args._.push(a);
  }
  if (process.env.QODER_CN_YES === "1") args.yes = true;
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
  console.log(`
${c.bold("qoder-cn-infer")} ${c.dim(VERSION)} — Qoder CN quota as a local OpenAI API
${c.dim("Not the official Qoder CLI (that is qoderclicn / qodercn).")}

${c.bold("Usage:")}
  qoder-cn-infer [OPTIONS] [COMMAND]

${c.bold("Commands:")}
  ${c.cyan("setup")}      Install prereqs, check login, start the API, wire clients
  ${c.cyan("doctor")}     Check Node, Qoder login, port, and health
  ${c.cyan("login")}      Sign in with qoderclicn (opens a browser)
  ${c.cyan("start")}      Start the local API
  ${c.cyan("stop")}       Stop the local API
  ${c.cyan("status")}     Show running state and the endpoint
  ${c.cyan("models")}     List models
  ${c.cyan("wire")}       Write Hermes / OpenCode provider config
  ${c.cyan("uninstall")}  Remove the user service and PATH shim
  ${c.cyan("help")}       Show this help
  ${c.cyan("version")}    Print version

${c.bold("Options:")}
  -y, --yes          Non-interactive (for agents / CI)
      --json         Machine-readable output
      --host <addr>  Bind address (default 127.0.0.1)
      --port <n>     Port (default 8787)
  -h, --help

${c.bold("Human walkthrough:")}
  1. ${c.cyan("qoder-cn-infer setup")}
  2. If it asks you to log in, finish the browser page, then press Enter
  3. Copy the Base URL it prints into Hermes / OpenCode

${c.bold("Agent / non-interactive:")}
  qoder-cn-infer setup --yes
  # or:  ./scripts/install.sh --yes

Only login cannot be automated without a Qoder account.
`.trimEnd());
}

function jsonOut(obj) {
  console.log(JSON.stringify(obj));
}

function hasLogin() {
  const user = path.join(os.homedir(), ".qoder-cn", ".auth", "user");
  const mid = path.join(os.homedir(), ".qoder-cn", ".auth", "machine_id");
  if (process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT) return true;
  try {
    return fs.statSync(user).size > 8 && fs.statSync(mid).size > 4;
  } catch {
    return false;
  }
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
  console.log(c.bold("qoder-cn-infer doctor"));
  for (const x of checks) console.log(x.ok ? c.ok(`${x.id}  ${x.detail}`) : c.bad(`${x.id}  ${x.detail}`));
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

function cmdLogin(args) {
  const bin = which("qoderclicn") || which("qodercn");
  if (!bin) {
    if (args.json) jsonOut({ ok: false, error: "qoderclicn_missing" });
    else console.log(c.bad("qoderclicn not installed. run  qoder-cn-infer setup"));
    return 1;
  }
  if (!args.json) {
    console.log(c.cyan("Opening Qoder CN login in your browser…"));
    console.log(c.dim("If nothing opens, run:  qoderclicn login"));
  }
  const r = spawnSync(bin, ["login"], { stdio: args.json ? "pipe" : "inherit" });
  const ok = hasLogin();
  if (args.json) jsonOut({ ok, status: r.status });
  else console.log(ok ? c.ok("signed in") : c.skip("login not detected yet — finish the browser page, then qoder-cn-infer doctor"));
  return ok ? 0 : 2;
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
    if (!args.json) console.log(ok ? c.ok(`${id.padEnd(14)} ${detail}`) : c.bad(`${id.padEnd(14)} ${detail}`));
  };

  if (!args.json) {
    console.log("");
    console.log(c.bold("qoder-cn-infer setup"));
    console.log(c.dim("Local OpenAI API for your Qoder CN quota. Login is the only manual step."));
    console.log("");
  }

  const nodeOk = Number(process.versions.node.split(".")[0]) >= 18;
  step("node", nodeOk, `v${process.versions.node}`);
  if (!nodeOk) {
    if (args.json) jsonOut({ ok: false, error: "node_too_old", report });
    return 1;
  }

  const cli = ensureQoderCli(args.yes);
  step("qoderclicn", cli.ok, cli.ok ? cli.path + (cli.installed ? " (installed)" : "") : cli.error);
  if (!cli.ok) {
    if (args.json) jsonOut({ ok: false, error: "qoderclicn", report });
    return 1;
  }

  linkCli();
  step("cli", true, BIN_LINK);

  if (!hasLogin()) {
    step("login", false, "not signed in");
    if (args.yes) {
      if (args.json) jsonOut({ ok: false, error: "not_logged_in", hint: "run qoderclicn login or set QODERCN_PERSONAL_ACCESS_TOKEN", report });
      else {
        console.log("");
        console.log(c.yellow("Stop: Qoder login is required (cannot be skipped)."));
        console.log("  1. Run  " + c.cyan("qoderclicn login"));
        console.log("  2. Sign in in the browser");
        console.log("  3. Run  " + c.cyan("qoder-cn-infer setup --yes") + "  again");
      }
      return 2;
    }
    console.log("");
    console.log("A browser window should open for Qoder CN.");
    cmdLogin({ json: false, yes: false });
    waitEnter(false, "Press Enter after you finish signing in… ");
    if (!hasLogin()) {
      step("login", false, "still missing");
      return 2;
    }
  }
  step("login", true, "signed in");

  const code = await cmdStart({ ...args, json: false });
  const healthy = await isHealthy(cfg);
  step("api", healthy, healthy ? endpoint(cfg) : "failed to start");
  if (!healthy) {
    if (args.json) jsonOut({ ok: false, error: "start_failed", report });
    return code || 1;
  }

  const h = wireHermes(cfg);
  const o = wireOpenCode(cfg);
  step("clients", true, `Hermes + OpenCode → ${endpoint(cfg)}`);

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
    console.log(c.bold("Done. Use this in any OpenAI-compatible client:"));
    console.log("");
    console.log(`  Base URL   ${c.cyan(endpoint(cfg))}`);
    console.log(`  API key    ${c.cyan("not-used")}`);
    console.log(`  Model      ${c.cyan("qwen3.8-max")}   ${c.dim("(or qwen3.8-flash / efficient)")}`);
    console.log("");
    console.log(c.dim("Hermes: hermes model  →  qoder-cn-infer / qwen3.8-max"));
    console.log(c.dim("Keep it running: the user service restarts it automatically."));
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
