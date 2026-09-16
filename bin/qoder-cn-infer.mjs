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
import { fetchAccountUsage, formatResetIn } from "../qoder_cn_endpoint/quota.mjs";
import { resolveIdentity } from "../qoder_cn_endpoint/cn_auth.mjs";
import { buildSession } from "../qoder_cn_endpoint/cn_cosy.mjs";
import { usageSummary, usagePath, formatCompact } from "../qoder_cn_endpoint/usage_store.mjs";
import { createBot } from "../qoder_cn_endpoint/telegram.mjs";
import { claimStatus, runClaim } from "../qoder_cn_endpoint/claim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VERSION = "1.5.1";
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
const TG_UNIT_NAME = "qoder-cn-infer-telegram.service";
const TG_UNIT_PATH = path.join(os.homedir(), ".config", "systemd", "user", TG_UNIT_NAME);
const TG_PID_PATH = path.join(STATE_DIR, "telegram.pid");
const TG_LOG_PATH = path.join(STATE_DIR, "telegram.log");
const TG_CONFIG_PATH = path.join(CONFIG_DIR, "telegram.json");

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
    profiles: [],
    allProfiles: false,
    noProfiles: false,
    refresh: false,
    localOnly: false,
    tgToken: "",
    chat: "",
    report: false,
    install: false,
    uninstall: false,
    plain: false,
  };
  const addProfiles = (v) => {
    for (const s of String(v || "").split(",")) {
      const name = s.trim();
      if (name && !args.profiles.includes(name)) args.profiles.push(name);
    }
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
    else if (a === "--profile") addProfiles(argv[++i] || "");
    else if (a.startsWith("--profile=")) addProfiles(a.slice(10));
    else if (a === "--profiles" || a === "--all-profiles") args.allProfiles = true;
    else if (a === "--no-profiles") args.noProfiles = true;
    else if (a === "--refresh") args.refresh = true;
    else if (a === "--local") args.localOnly = true;
    else if (a === "--tg-token") args.tgToken = argv[++i] || "";
    else if (a.startsWith("--tg-token=")) args.tgToken = a.slice(11);
    else if (a === "--chat") args.chat = argv[++i] || "";
    else if (a.startsWith("--chat=")) args.chat = a.slice(7);
    else if (a === "--report") args.report = true;
    else if (a === "--install") args.install = true;
    else if (a === "--uninstall") args.uninstall = true;
    else if (a === "--plain") args.plain = true;
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
  console.log(cmd("usage", "Credits, tokens, and reset window"));
  console.log(cmd("claim", "Redeem Qoder promo credits (/claim)"));
  console.log(cmd("wire", "Write Hermes / OpenCode config"));
  console.log(cmd("telegram", "Usage bot for Telegram (/usage)"));
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
  console.log(`    ${c.mag("--profiles")}             ${c.dim("wire every Hermes bot profile")}`);
  console.log(`    ${c.mag("--profile")} ${c.dim("<name>")}       ${c.dim("wire one profile (repeatable)")}`);
  console.log(`    ${c.mag("--no-profiles")}          ${c.dim("never touch Hermes profiles")}`);
  console.log(`    ${c.mag("--refresh")}              ${c.dim("usage: bypass account cache")}`);
  console.log(`    ${c.mag("--local")}                ${c.dim("usage: skip the Qoder account call")}`);
  console.log(`    ${c.mag("--plain")}                ${c.dim("usage: compact text for chat relays")}`);
  console.log(`    ${c.mag("--tg-token")} ${c.dim("<t>")}       ${c.dim("telegram: BotFather token (stored 600)")}`);
  console.log(`    ${c.mag("--chat")} ${c.dim("<id>")}           ${c.dim("telegram: bind a chat id")}`);
  console.log(`    ${c.mag("--install")}              ${c.dim("telegram: run as a service")}`);
  console.log(`    ${c.mag("--report")}               ${c.dim("telegram: one-shot usage push")}`);
  console.log(`    ${c.mag("--uninstall")}            ${c.dim("telegram: remove the service")}`);
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

function startSystemd(unit = UNIT_NAME) {
  spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  const en = spawnSync("systemctl", ["--user", "enable", "--now", unit], { encoding: "utf8" });
  spawnSync("loginctl", ["enable-linger", os.userInfo().username], { encoding: "utf8" });
  return en.status === 0;
}

function stopSystemd(unit = UNIT_NAME) {
  spawnSync("systemctl", ["--user", "disable", "--now", unit], { encoding: "utf8" });
}

function writeTelegramUnit() {
  const node = process.execPath;
  const cli = path.join(ROOT, "bin", "qoder-cn-infer.mjs");
  const unit = `[Unit]
Description=Qoder CN usage Telegram bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=PATH=${path.dirname(node)}:/usr/bin:/bin
ExecStart=${node} ${cli} telegram
Restart=always
RestartSec=3
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(TG_UNIT_PATH), { recursive: true });
  fs.writeFileSync(TG_UNIT_PATH, unit);
}

function startTelegramNohup() {
  ensureDirs();
  const node = process.execPath;
  const cli = path.join(ROOT, "bin", "qoder-cn-infer.mjs");
  const out = fs.openSync(TG_LOG_PATH, "a");
  const child = spawn(node, [cli, "telegram"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.writeFileSync(TG_PID_PATH, String(child.pid));
  return child.pid;
}

function stopTelegramNohup() {
  try {
    const pid = Number(fs.readFileSync(TG_PID_PATH, "utf8").trim());
    if (pid) process.kill(pid, "SIGTERM");
    fs.unlinkSync(TG_PID_PATH);
  } catch {
    /* ignore */
  }
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

function hermesProfilesDir() {
  return (
    process.env.QODER_CN_INFER_HERMES_PROFILES_DIR ||
    path.join(os.homedir(), ".hermes", "profiles")
  );
}

function hermesProviderBlock(cfg) {
  return `
  qoder-cn-infer:
    name: Qoder CN
    base_url: ${endpoint(cfg)}
    api_key: not-used
    transport: chat_completions
    discover_models: true
`.replace(/^\n/, "");
}

/**
 * Telegram quick commands: run the CLI directly in the gateway process
 * (no LLM turn, 30s cap) so `/qoder` and `/claim` reply instantly.
 */
const QUICK_COMMANDS = [
  { name: "qoder", exec: "$HOME/.local/bin/qoder-cn-infer usage --refresh" },
  { name: "claim", exec: "$HOME/.local/bin/qoder-cn-infer claim" },
];

function quickCommandEntries(pad, entries) {
  return entries
    .map((qc) => `${pad}  ${qc.name}:\n${pad}    type: exec\n${pad}    command: "${qc.exec}"`)
    .join("\n");
}

/** Merge the /qoder + /claim quick commands into config text; {text, added}. */
function ensureQuickCommand(text) {
  const missing = QUICK_COMMANDS.filter((qc) => !text.includes(qc.exec));
  if (!missing.length) return { text, added: false };
  let m = text.match(/^([ \t]*)quick_commands:[ \t]*\{[ \t]*\}[ \t]*$/m);
  if (m) {
    const pad = m[1];
    return {
      text: text.replace(m[0], `${pad}quick_commands:\n${quickCommandEntries(pad, missing)}`),
      added: true,
    };
  }
  m = text.match(/^([ \t]*)quick_commands:[ \t]*$/m);
  if (m) {
    // Replace just the key line; any existing entries stay below the new ones.
    const pad = m[1];
    return {
      text: text.replace(m[0], `${pad}quick_commands:\n${quickCommandEntries(pad, missing)}`),
      added: true,
    };
  }
  return {
    text: `${text.replace(/\s*$/, "")}\n\nquick_commands:\n${quickCommandEntries("", missing)}\n`,
    added: true,
  };
}

/**
 * Merge the qoder-cn-infer provider block (and the /qoder quick command) into
 * a Hermes config file. Never touches model.default in existing files; only
 * creates it for a fresh main config. Base URLs of an existing qoder block are
 * refreshed in place.
 */
function wireHermesAt(cfg, configPath, { setDefaultOnCreate = false } = {}) {
  const block = hermesProviderBlock(cfg);
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const head = setDefaultOnCreate
      ? `model:\n  default: qwen3.8-max\n  provider: qoder-cn-infer\n`
      : `# Hermes profile config — qoder-cn-infer provider (default model untouched)\n`;
    fs.writeFileSync(
      configPath,
      `${head}providers:\n${block}\nquick_commands:\n${quickCommandEntries("", QUICK_COMMANDS)}\n`
    );
    return { ok: true, path: configPath, created: true, quick_command: true };
  }
  let text = fs.readFileSync(configPath, "utf8");
  const ensured = ensureQuickCommand(text);
  text = ensured.text;
  if (
    /^\s+qoder-cn-infer:/m.test(text) ||
    /^\s+qoder-cn:/m.test(text) ||
    /base_url:\s*http:\/\/127\.0\.0\.1:8787/m.test(text)
  ) {
    text = text.replace(/base_url:\s*http:\/\/127\.0\.0\.1:\d+(\/v1)?/g, `base_url: ${endpoint(cfg)}`);
    fs.writeFileSync(configPath, text);
    return { ok: true, path: configPath, updated: true, quick_command: ensured.added };
  }
  if (/^providers:\s*$/m.test(text)) {
    text = text.replace(/^providers:\s*$/m, `providers:\n${block.trimEnd()}`);
  } else if (/^providers:/m.test(text)) {
    text = text.replace(/^providers:\s*\n/m, `providers:\n${block}`);
  } else {
    text += `\nproviders:\n${block}`;
  }
  fs.writeFileSync(configPath, text);
  return { ok: true, path: configPath, updated: true, quick_command: ensured.added };
}

function wireHermes(cfg) {
  return wireHermesAt(cfg, path.join(os.homedir(), ".hermes", "config.yaml"), {
    setDefaultOnCreate: true,
  });
}

/** Is a Hermes Agent installed on this machine (dir or CLI on PATH)? */
function detectHermesAgent() {
  return fs.existsSync(path.join(os.homedir(), ".hermes")) || Boolean(which("hermes"));
}

/** Is OpenCode installed on this machine (config dir or CLI on PATH)? */
function detectOpenCode() {
  return fs.existsSync(path.join(os.homedir(), ".config", "opencode")) || Boolean(which("opencode"));
}

/**
 * Hermes Telegram gateway bots run as profiles under ~/.hermes/profiles/<name>/.
 * Detect ones with a config.yaml or gateway artifacts.
 */
function detectHermesProfiles(base = hermesProfilesDir()) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const configPath = path.join(dir, "config.yaml");
    const configExists = fs.existsSync(configPath);
    let looksLikeProfile = configExists;
    if (!looksLikeProfile) {
      for (const marker of ["profile.yaml", ".env", "gateway.pid", "gateway.lock"]) {
        if (fs.existsSync(path.join(dir, marker))) {
          looksLikeProfile = true;
          break;
        }
      }
    }
    if (!looksLikeProfile) continue;
    out.push({ name: e.name, dir, config_path: configPath, config_exists: configExists });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function profileIsWired(configPath) {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return (
      /^\s+qoder-cn-infer:/m.test(text) ||
      /base_url:\s*http:\/\/127\.0\.0\.1:8787/m.test(text)
    );
  } catch {
    return false;
  }
}

/**
 * Wire the provider block into Hermes bot profiles.
 *   names: explicit profile names (must exist in profiles/ to be wired)
 *   all:   wire every detected profile that has a config.yaml
 * Profiles without a config.yaml are reported as skipped, never created —
 * a profile's default model is always the operator's choice.
 */
function wireHermesProfiles(cfg, { names = [], all = false } = {}) {
  const detected = detectHermesProfiles();
  const results = [];
  const targets = names.length
    ? names.map((name) => detected.find((p) => p.name === name) || { name, missing: true })
    : all
      ? detected
      : [];
  for (const target of targets) {
    if (target.missing) {
      results.push({ name: target.name, path: "", status: "not_found" });
      continue;
    }
    if (!target.config_exists) {
      results.push({ name: target.name, path: target.config_path, status: "skipped_no_config" });
      continue;
    }
    const r = wireHermesAt(cfg, target.config_path);
    results.push({
      name: target.name,
      path: target.config_path,
      status: r.created ? "created" : "wired",
    });
  }
  return { profiles: results, detected };
}

function printProfileResults(result) {
  const list = result.profiles || [];
  if (!list.length) {
    console.log(c.dim("profiles  none detected"));
    return;
  }
  for (const p of list) {
    const label = `profile   ${p.name}`;
    if (p.status === "wired" || p.status === "created") console.log(c.ok(`${label}  ${p.path}`));
    else if (p.status === "skipped_no_config")
      console.log(c.skip(`${label}  no config.yaml yet (skipped)`));
    else if (p.status === "not_found") console.log(c.bad(`${label}  not found`));
    else console.log(c.bad(`${label}  ${p.status}`));
  }
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
  // Hermes bot profiles (Telegram gateways) — informational: wiring is a
  // deliberate choice, so an unwired profile is reported but never fails doctor.
  for (const p of detectHermesProfiles()) {
    if (!p.config_exists) {
      checks.push({ id: `profile:${p.name}`, ok: true, detail: "no config.yaml (skipped)" });
      continue;
    }
    const wired = profileIsWired(p.config_path);
    checks.push({
      id: `profile:${p.name}`,
      ok: true,
      detail: wired ? "wired" : "not wired (qoder-cn-infer wire --profiles)",
    });
  }
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
  console.log(c.dim("usage    qoder-cn-infer usage  (credits · tokens)"));
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
      const ctx = m.context_length ? c.dim(`  ${fmtCtx(m.context_length)}`) : "";
      console.log(`${c.bold(m.id)}${rate}${ctx}  ${m.name || ""}`);
    }
  }
  return 0;
}

function fmtCtx(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${Math.round(v / 100000) / 10}M`;
  return `${Math.round(v / 1000)}K`;
}

function fmtCredits(n) {
  const v = Number(n) || 0;
  if (v === 0) return "0";
  if (v < 0.0001) return "<0.0001";
  return String(Math.round(v * 10000) / 10000);
}

function fmtQuotaNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function usageBar(pct, width = 28) {
  const clamped = Math.max(0, Math.min(1, Number(pct) || 0));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtDateTime(ms) {
  const d = new Date(Number(ms));
  if (!ms || Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Collect the usage picture: live account quota from the running API (or a
 * direct login fetch when the API is down) plus the local meter from disk.
 */
async function collectUsage(args = {}) {
  const cfg = loadConfig();
  const healthy = await isHealthy(cfg);
  let account = null;
  let accountError = null;
  let local = null;
  let source = "file";
  if (healthy) {
    const params = [];
    if (args.refresh) params.push("refresh=1");
    if (args.localOnly) params.push("local=1");
    const qs = params.length ? `?${params.join("&")}` : "";
    const r = await httpGet(
      `http://${cfg.host || DEFAULT_HOST}:${cfg.port || DEFAULT_PORT}/usage${qs}`,
      25000
    );
    if (r.status === 200) {
      try {
        const data = JSON.parse(r.body);
        account = data.account || null;
        accountError = data.account_error || null;
        local = data.local || null;
        source = data.source || "server";
      } catch {
        accountError = "bad /usage response from server";
      }
    } else {
      accountError = r.error || `HTTP ${r.status}`;
    }
  }
  if (!local) local = usageSummary();
  if (!account && !accountError && !args.localOnly && hasLogin()) {
    try {
      const id = await resolveIdentity();
      const sess = buildSession(id.identity, id.machineId, id.machineToken, id.machineType);
      account = await fetchAccountUsage(sess);
      source = "direct";
    } catch (e) {
      accountError = String(e?.message || e);
    }
  }
  return { account, accountError, local, source, healthy, endpoint: endpoint(cfg), cfg };
}

/**
 * Compact one-screen usage text: chat relays, quick commands, cron.
 * Plain lines, no ANSI, no banner.
 */
function formatUsagePlain({ account, accountError, local, source, endpoint: ep } = {}) {
  const lines = [];
  const u = account?.qoderUsage;
  if (u) {
    const q = u.userQuota;
    const pct = (Number(u.totalUsagePercentage) || 0) * 100;
    if (q) {
      lines.push(
        `Qoder CN credits: ${fmtQuotaNumber(q.used)}/${fmtQuotaNumber(q.total)} used (${pct.toFixed(1)}%) · ${fmtQuotaNumber(q.remaining)} ${q.unit || "credits"} remaining`
      );
    } else {
      lines.push(`Qoder CN usage: ${pct.toFixed(1)}% of plan`);
    }
    if (u.expiresAt) {
      lines.push(`Resets ${fmtDateTime(u.expiresAt)} (${formatResetIn(u.expiresAt)}) · plan ${u.userType || "?"}`);
    }
    if (u.isQuotaExceeded) lines.push("Quota exceeded — switch models or wait for the reset.");
  } else if (account?.displayMode === "enterprise") {
    lines.push(`Enterprise plan — usage: ${account.enterpriseUsage?.detailUrl || ""}`);
  } else if (accountError) {
    lines.push(`Account: ${accountError}`);
  } else {
    lines.push("Account: not signed in — qoder-cn-infer login");
  }
  const t = local?.totals;
  if (t) {
    lines.push(
      `Local: ${t.requests} reqs · ${formatCompact(t.total_tokens)} tokens (${formatCompact(t.prompt_tokens)} in / ${formatCompact(t.completion_tokens)} out · ${formatCompact(t.reasoning_tokens)} thinking) · ${fmtCredits(t.credits)} credits`
    );
    lines.push(
      `Today: ${formatCompact(local.today?.total_tokens || 0)} tokens · ${fmtCredits(local.today?.credits)} credits`
    );
  }
  if (ep) lines.push(`API ${ep} · source ${source || "?"}`);
  return lines.join("\n");
}

/**
 * Credits + tokens: the Qoder account quota (same numbers qoderclicn shows)
 * and the local meter of everything this facade served.
 */
async function cmdUsage(args) {
  const { account, accountError, local, source, healthy, cfg } = await collectUsage(args);
  if (args.json) {
    jsonOut({
      ok: true,
      account,
      account_error: accountError,
      source,
      local,
      endpoint: endpoint(cfg),
      server_running: healthy,
    });
    return 0;
  }
  if (args.plain) {
    console.log(
      formatUsagePlain({ account, accountError, local, source, endpoint: endpoint(cfg) })
    );
    return 0;
  }

  printBanner("Usage", "Qoder CN account quota and what the facade has served.");
  printHeader("Qoder CN account");
  if (args.localOnly) {
    console.log("  " + c.skip("skipped (--local)"));
  } else if (account?.displayMode === "enterprise") {
    console.log(`  ${c.fg("Enterprise plan")}  ${c.dim("— usage is tracked in the Qoder console")}`);
    console.log(`  ${c.dim("Details   ")}  ${c.cyan(account.enterpriseUsage.detailUrl)}`);
  } else if (account?.qoderUsage) {
    const u = account.qoderUsage;
    const quota = u.userQuota;
    const pct = Number(u.totalUsagePercentage) || 0;
    console.log(`  ${c.dim("Plan      ")}  ${c.fg(u.userType)}`);
    if (quota) {
      console.log(
        `  ${c.dim("Credits   ")}  ${c.fg(`${fmtQuotaNumber(quota.used)} / ${fmtQuotaNumber(quota.total)} used`)}  ${c.dim(`(${(pct * 100).toFixed(1)}%)`)}`
      );
      const barColor = pct >= 0.85 ? c.red : pct >= 0.6 ? c.yellow : c.green;
      console.log(`  ${c.dim("Bar       ")}  ${barColor(usageBar(pct))}  ${c.dim(`${(pct * 100).toFixed(0)}%`)}`);
      console.log(
        `  ${c.dim("Remaining ")}  ${c.fg(`${fmtQuotaNumber(quota.remaining)} ${quota.unit}`)}`
      );
      if (u.addOnQuota) {
        console.log(
          `  ${c.dim("Add-on    ")}  ${c.fg(`${fmtQuotaNumber(u.addOnQuota.remaining)} ${u.addOnQuota.unit} left`)}`
        );
      }
    } else {
      console.log(`  ${c.dim("Usage     ")}  ${c.fg(`${(pct * 100).toFixed(1)}% of plan`)}`);
    }
    if (u.expiresAt) {
      console.log(
        `  ${c.dim("Resets    ")}  ${c.fg(fmtDateTime(u.expiresAt))}  ${c.dim(formatResetIn(u.expiresAt))}`
      );
    }
    if (u.isQuotaExceeded) {
      console.log("  " + c.bad("quota exceeded — switch models or wait for the reset"));
    }
    if (u.upgradeUrl) console.log(`  ${c.dim("Upgrade   ")}  ${c.dim(u.upgradeUrl)}`);
    console.log(
      `  ${c.dim("Source    ")}  ${c.dim(source === "cache" ? "cache ≤60s (--refresh for live)" : source)}`
    );
  } else if (accountError) {
    console.log("  " + c.bad(accountError));
  } else {
    console.log("  " + c.skip("not signed in — qoder-cn-infer login"));
  }

  printHeader("Local meter");
  const t = local.totals || {};
  console.log(
    `  ${c.dim("Requests  ")}  ${c.fg(String(t.requests || 0))}${t.billable_requests !== t.requests ? c.dim(`  (${t.billable_requests || 0} billable)`) : ""}`
  );
  console.log(
    `  ${c.dim("Tokens    ")}  ${c.fg(formatCompact(t.total_tokens || 0))} total  ${c.dim(`· ${formatCompact(t.prompt_tokens || 0)} in · ${formatCompact(t.completion_tokens || 0)} out · ${formatCompact(t.reasoning_tokens || 0)} thinking · ${formatCompact(t.cached_tokens || 0)} cached`)}`
  );
  console.log(`  ${c.dim("Credits   ")}  ${c.fg(fmtCredits(t.credits))}`);
  console.log(
    `  ${c.dim("Today     ")}  ${c.fg(formatCompact(local.today?.total_tokens || 0))} tokens  ${c.dim("·")}  ${c.fg(fmtCredits(local.today?.credits))}`
  );
  const models = Object.entries(local.models || {});
  if (models.length) {
    printHeader("By model");
    for (const [name, m] of models.sort((a, b) => (b[1].credits || 0) - (a[1].credits || 0))) {
      console.log(
        `  ${c.fg(name.padEnd(18))} ${String(m.requests).padStart(4)} req  ${String(formatCompact(m.total_tokens)).padStart(8)} tok  ${fmtCredits(m.credits)} cr`
      );
    }
  }
  if ((local.recent || []).length > 1) {
    printHeader("Recent days");
    for (const d of local.recent) {
      console.log(
        `  ${c.dim(d.day)}  ${String(d.requests).padStart(4)} req  ${String(formatCompact(d.total_tokens)).padStart(8)} tok  ${fmtCredits(d.credits)} cr`
      );
    }
  }
  console.log("");
  if (!healthy) {
    printInfo("API not running — local meter read from disk:", usagePath());
    console.log("");
  }
  return 0;
}

/**
 * Claim Qoder promo/activity credits (the CLI's /claim). Server-driven: when
 * Qoder isn't offering a claim command for this account, it reports that.
 */
async function cmdClaim(args) {
  if (!hasLogin()) {
    if (args.json) jsonOut({ ok: false, error: "not_logged_in" });
    else console.log("  " + c.bad("not signed in — qoder-cn-infer login"));
    return 2;
  }
  let status;
  try {
    const id = await resolveIdentity();
    const sess = buildSession(id.identity, id.machineId, id.machineToken, id.machineType);
    status = await claimStatus(sess);
    let result = null;
    if (status.offered) {
      result = await runClaim(status.def, sess, {
        log: (m) => {
          if (!args.json) console.log(c.dim(`  ${m}`));
        },
      });
    }
    if (args.json) {
      jsonOut({
        ok: status.offered ? Boolean(result?.ok) : true,
        offered: status.offered,
        campaigns: status.campaigns,
        claimed: result?.claimed ?? [],
        claimable: result?.claimable ?? [],
        errors: result?.errors ?? [],
        note: result?.note ?? null,
        gates_error: status.gatesError,
        campaigns_error: status.campaignsError,
      });
      return 0;
    }
    printBanner("Claim", "Qoder CN promo / activity credits.");
    printHeader("Qoder CN claim");
    if (!status.offered) {
      console.log(`  ${c.dim("Offered   ")}  ${c.skip("nothing to claim right now")}`);
      if (status.campaigns) {
        const cs = status.campaigns;
        console.log(
          `  ${c.dim("Campaigns ")}  ${c.fg(cs.claimable ? "claimable" : "none active")}  ${c.dim(`· ${cs.count} campaign(s)`)}`
        );
        if (cs.campaignUrl) console.log(`  ${c.dim("Details   ")}  ${c.dim(cs.campaignUrl)}`);
      }
      if (status.gatesError) console.log(`  ${c.dim("Gates     ")}  ${c.dim(status.gatesError)}`);
      if (status.campaignsError) console.log(`  ${c.dim("Campaigns ")}  ${c.dim(status.campaignsError)}`);
      console.log("");
      printInfo("Qoder only offers /claim while a promotion/activity is active for your account.", "When it appears, run this command (or /claim in Telegram) to redeem it.");
    } else {
      const claimed = result?.claimed ?? [];
      if (claimed.length) {
        console.log("  " + c.ok(`${claimed.length} activit${claimed.length === 1 ? "y" : "ies"} claimed`));
      } else if (result?.note === "nothing_claimable") {
        console.log("  " + c.skip("offered, but nothing claimable right now (already claimed or not eligible)"));
      }
      for (const err of result?.errors ?? []) console.log("  " + c.bad(err));
      if (result && !result.ok && !claimed.length) {
        printInfo("If this keeps failing, redeem via the official CLI: run  qoderclicn  then  /claim");
      }
    }
    console.log("");
    console.log(c.dim("usage      qoder-cn-infer usage --refresh   (see the credits move)"));
    console.log("");
    return 0;
  } catch (e) {
    if (args.json) jsonOut({ ok: false, error: String(e?.message || e) });
    else console.log("  " + c.bad(String(e?.message || e)));
    return 1;
  }
}

function loadTelegramConfig() {
  try {
    return JSON.parse(fs.readFileSync(TG_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveTelegramConfig(tgc) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TG_CONFIG_PATH, JSON.stringify(tgc, null, 2) + "\n");
  try {
    fs.chmodSync(TG_CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

async function collectStatus() {
  const cfg = loadConfig();
  const healthy = await isHealthy(cfg);
  return { running: healthy, login: hasLogin(), endpoint: endpoint(cfg) };
}

/**
 * Telegram usage bot: /usage, /status, /help in any chat.
 *   --tg-token <t>   BotFather token (stored in ~/.config/qoder-cn-infer/telegram.json, mode 600)
 *   --chat <id>      pre-bind a chat id
 *   --install        run under systemd (or nohup) and exit
 *   --report         send one usage push to the bound chat and exit (cron-friendly)
 *   --uninstall      stop and remove the service
 */
async function cmdTelegram(args) {
  const tgc = loadTelegramConfig();
  if (args.tgToken) {
    tgc.token = args.tgToken.trim();
    saveTelegramConfig(tgc);
  }
  const token = (args.tgToken || "").trim() || process.env.QODER_CN_INFER_TG_TOKEN || tgc.token || "";

  if (args.uninstall) {
    stopSystemd(TG_UNIT_NAME);
    stopTelegramNohup();
    try {
      fs.unlinkSync(TG_UNIT_PATH);
    } catch {
      /* ignore */
    }
    if (args.json) jsonOut({ ok: true, removed: true });
    else console.log(c.ok("telegram bot service removed (telegram.json kept)"));
    return 0;
  }
  if (!token) {
    if (args.json) {
      jsonOut({
        ok: false,
        error: "token_missing",
        hint: "qoder-cn-infer telegram --tg-token <BOTFATHER_TOKEN>",
      });
    } else {
      printBanner("Telegram usage bot");
      console.log("  " + c.bad("no bot token yet. Create one with @BotFather:"));
      printInfo(
        "1. Telegram → @BotFather → /newbot → copy the token",
        "2. qoder-cn-infer telegram --tg-token <token> --install"
      );
    }
    return 2;
  }

  const chatFromFlag = args.chat ? Number(args.chat) : null;
  const state = {
    chat_id: tgc.chat_id ?? (Number.isFinite(chatFromFlag) ? chatFromFlag : null),
    offset: tgc.offset || 0,
  };
  const persist = () => {
    tgc.chat_id = state.chat_id;
    tgc.offset = state.offset;
    saveTelegramConfig(tgc);
  };
  const bot = createBot({
    token,
    state,
    persist,
    collectUsage: () => collectUsage({ refresh: true }),
    collectStatus,
    log: (m) => {
      if (!args.json) console.log(c.dim(`  tg  ${m}`));
    },
  });

  if (args.install) {
    if (!tgc.token) {
      tgc.token = token;
      saveTelegramConfig(tgc);
    }
    writeTelegramUnit();
    let how = "nohup";
    if (haveSystemdUser() && startSystemd(TG_UNIT_NAME)) how = "systemd";
    else startTelegramNohup();
    if (args.json) jsonOut({ ok: true, installed: { how }, state });
    else {
      printBanner("Telegram usage bot");
      console.log(c.ok(`installed (${how}) — restarts itself`));
      printInfo(
        "Message your bot once to bind it, then send  /usage",
        "One-shot push:  qoder-cn-infer telegram --report"
      );
    }
    return 0;
  }

  if (args.report) {
    try {
      const chatId = await bot.sendReport();
      if (args.json) jsonOut({ ok: true, sent_to: chatId });
      else console.log(c.ok(`usage report sent to chat ${chatId}`));
      return 0;
    } catch (e) {
      if (args.json) jsonOut({ ok: false, error: String(e?.message || e) });
      else console.log("  " + c.bad(String(e?.message || e)));
      return 1;
    }
  }

  if (!args.json) {
    printBanner("Telegram usage bot", "Ctrl+C to stop. /usage · /status · /help");
    console.log(
      c.dim(`  polling — ${state.chat_id ? `bound to chat ${state.chat_id}` : "first message binds this bot"}`)
    );
    console.log("");
  }
  await bot.run({});
  return 0;
}

function selectProfilesForWiring(args) {
  if (args.noProfiles) return null;
  if (args.profiles.length) return { names: args.profiles };
  if (args.allProfiles) return { all: true };
  if (args.yes) return { all: true };
  return null;
}

function cmdWire(args) {
  const cfg = loadConfig();
  const h = wireHermes(cfg);
  const o = wireOpenCode(cfg);
  const selection = selectProfilesForWiring(args);
  const profileResult = selection ? wireHermesProfiles(cfg, selection) : null;
  if (args.json)
    jsonOut({
      hermes: h,
      opencode: o,
      profiles: profileResult ? profileResult.profiles : [],
      endpoint: endpoint(cfg),
    });
  else {
    console.log(c.ok(`Hermes    ${h.path}`));
    if (h.quick_command) {
      console.log(c.dim("          /qoder + /claim quick commands added — restart the Hermes gateway to load them"));
    }
    console.log(c.ok(`OpenCode  ${o.path}`));
    if (profileResult) printProfileResults(profileResult);
    else console.log(c.dim("profiles  skipped (--profiles wires Hermes bot profiles)"));
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
  const hermesHere = detectHermesAgent();
  const opencodeHere = detectOpenCode();
  let wireH = hermesHere;
  let wireO = opencodeHere;
  if (interactive) {
    wireH = await promptYesNo("  Wire Hermes Agent (~/.hermes/config.yaml)?", hermesHere);
    wireO = await promptYesNo("  Wire OpenCode (~/.config/opencode/opencode.json)?", opencodeHere);
  }
  const h = wireH ? wireHermes(cfg) : { path: "(skipped)" };
  const o = wireO ? wireOpenCode(cfg) : { path: "(skipped)" };
  if (wireH) printOk(`Hermes    ${h.path}`);
  else printInfo(hermesHere ? "Hermes skipped" : "Hermes not detected — skipped (qoder-cn-infer wire to force)");
  if (wireO) printOk(`OpenCode  ${o.path}`);
  else printInfo(opencodeHere ? "OpenCode skipped" : "OpenCode not detected — skipped (qoder-cn-infer wire to force)");
  const clientBits = [wireH ? "Hermes" : "", wireO ? "OpenCode" : ""].filter(Boolean);
  step("clients", true, clientBits.length ? `wired ${clientBits.join(" + ")}` : "none detected — endpoint only");

  printHeader("Hermes bot profiles");
  printInfo("Telegram gateway bots run as Hermes profiles under ~/.hermes/profiles/.");
  const detectedProfiles = detectHermesProfiles();
  let profileResult = { profiles: [], detected: detectedProfiles };
  if (args.noProfiles) {
    step("profiles", true, "skipped (--no-profiles)");
  } else if (!detectedProfiles.length) {
    step("profiles", true, "none detected");
  } else {
    let selection = null;
    if (args.profiles.length) selection = { names: args.profiles };
    else if (args.allProfiles || args.yes) selection = { all: true };
    else if (interactive) {
      const names = detectedProfiles.map((p) => p.name).join(", ");
      const want = await promptYesNo(`  Wire detected profiles (${names})?`, true);
      if (want) selection = { all: true };
    } else {
      selection = { all: true };
    }
    if (selection) {
      profileResult = wireHermesProfiles(cfg, selection);
      const wiredList = profileResult.profiles.filter(
        (p) => p.status === "wired" || p.status === "created"
      );
      const skippedList = profileResult.profiles.filter((p) => p.status === "skipped_no_config");
      const failedList = profileResult.profiles.filter((p) => p.status === "not_found");
      const detailBits = [`${wiredList.length} wired`];
      if (skippedList.length) detailBits.push(`${skippedList.length} skipped`);
      if (failedList.length) detailBits.push(`${failedList.length} missing`);
      step("profiles", failedList.length === 0, detailBits.join(" · "));
      if (!args.json) {
        for (const p of profileResult.profiles) {
          if (p.status === "wired" || p.status === "created")
            printOk(`profile   ${p.name.padEnd(12)} ${ui.dim(p.path)}`);
          else if (p.status === "skipped_no_config")
            printInfo(`profile   ${p.name} skipped (no config.yaml yet)`);
          else printBad(`profile   ${p.name} ${p.status}`);
        }
      }
    } else {
      step("profiles", true, "skipped");
    }
  }

  if (args.json) {
    jsonOut({
      ok: true,
      endpoint: endpoint(cfg),
      api_key: "not-used",
      model: "qwen3.8-max",
      hermes: h.path,
      opencode: o.path,
      profiles: profileResult.profiles,
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
    usage: cmdUsage,
    claim: cmdClaim,
    wire: cmdWire,
    telegram: cmdTelegram,
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

const isMain = (() => {
  // realpath-aware: the installed CLI is a symlink (~/.local/bin/qoder-cn-infer),
  // so path.resolve(argv[1]) never equals the module's real path. Compare trees.
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(path.resolve(process.argv[1])) ===
        fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then((code) => process.exit(code ?? 0), (err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  parseArgs,
  hasLogin,
  endpoint,
  printHelp,
  formatUsagePlain,
  wireHermesAt,
  wireHermesProfiles,
  detectHermesProfiles,
  profileIsWired,
};
