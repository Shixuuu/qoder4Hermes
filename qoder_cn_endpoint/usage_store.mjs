/**
 * Local meter for what this facade has served: requests, tokens, credits.
 *
 * Lives beside the server PID in ~/.local/state/qoder-cn-infer/usage.json
 * (override the directory with QODER_CN_INFER_STATE_DIR — used by tests).
 *
 * Numbers come from the CN gateway's own usage event on each completion
 * (prompt/completion/reasoning/cached tokens + credits + billable), so this
 * meter matches what Qoder bills, not an estimate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_DAYS = 90;

export function stateDir() {
  return (
    process.env.QODER_CN_INFER_STATE_DIR ||
    path.join(os.homedir(), ".local", "state", "qoder-cn-infer")
  );
}

export function usagePath() {
  return path.join(stateDir(), "usage.json");
}

function zeroCounters() {
  return {
    requests: 0,
    billable_requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    credits: 0,
  };
}

export function emptyUsage() {
  return { updated_at: 0, totals: zeroCounters(), models: {}, days: {} };
}

const num0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function sanitizeCounters(raw) {
  const base = zeroCounters();
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(base)) base[k] = num0(raw[k]);
  }
  return base;
}

export function readUsage(file = usagePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = emptyUsage();
    out.updated_at = num0(raw.updated_at);
    out.totals = sanitizeCounters(raw.totals);
    if (raw.models && typeof raw.models === "object") {
      for (const [name, counters] of Object.entries(raw.models)) {
        out.models[name] = sanitizeCounters(counters);
      }
    }
    if (raw.days && typeof raw.days === "object") {
      for (const [day, counters] of Object.entries(raw.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.days[day] = sanitizeCounters(counters);
      }
    }
    return out;
  } catch {
    return emptyUsage();
  }
}

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function addInto(counters, entry) {
  counters.requests += 1;
  if (entry.billable !== false) counters.billable_requests += 1;
  counters.prompt_tokens += num0(entry.prompt_tokens);
  counters.completion_tokens += num0(entry.completion_tokens);
  const total =
    entry.total_tokens !== undefined
      ? num0(entry.total_tokens)
      : num0(entry.prompt_tokens) + num0(entry.completion_tokens);
  counters.total_tokens += total;
  counters.reasoning_tokens += num0(entry.reasoning_tokens);
  counters.cached_tokens += num0(entry.cached_tokens);
  counters.credits += num0(entry.credits);
}

function pruneDays(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > MAX_DAYS) delete days[keys.shift()];
}

// The server can have many in-flight streams finishing at once; serialize file
// writes through a promise chain so read-modify-write cannot interleave.
let writeChain = Promise.resolve();

/**
 * Record one metered completion. Never throws (a meter failure must not break
 * inference); returns a promise that settles after the write attempt.
 *
 * entry: { model, prompt_tokens, completion_tokens, total_tokens,
 *          reasoning_tokens, cached_tokens, credits, billable }
 */
export function recordUsage(entry, file = usagePath()) {
  writeChain = writeChain
    .then(() => {
      const usage = readUsage(file);
      const name = String(entry?.model || "unknown");
      addInto(usage.totals, entry);
      usage.models[name] = usage.models[name] || zeroCounters();
      addInto(usage.models[name], entry);
      const day = dayKey();
      usage.days[day] = usage.days[day] || zeroCounters();
      addInto(usage.days[day], entry);
      pruneDays(usage.days);
      usage.updated_at = Date.now();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(usage, null, 2) + "\n");
      fs.renameSync(tmp, file);
    })
    .catch(() => {});
  return writeChain;
}

/** Walk the write chain — lets the CLI/tests wait for in-flight records. */
export function flushUsage() {
  return writeChain;
}

/**
 * Readable summary for /usage and the CLI.
 * recent: last N day buckets, oldest first.
 */
export function usageSummary(usage = readUsage(), { days = 7 } = {}) {
  const recentDays = Object.entries(usage.days || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-days)
    .map(([day, counters]) => ({ day, ...counters }));
  return {
    updated_at: usage.updated_at,
    totals: usage.totals,
    today: usage.days[dayKey()] || zeroCounters(),
    models: usage.models,
    recent: recentDays,
  };
}

/** 45231 -> "45.2k" (compact display helper). */
export function formatCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v * 100) / 100);
}
