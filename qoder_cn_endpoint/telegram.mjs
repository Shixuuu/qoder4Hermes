/**
 * Minimal Telegram command bot for usage reporting — zero dependencies, fetch-based.
 *
 * Runs the same numbers as `qoder-cn-infer usage` in any Telegram chat:
 *   /usage   credits used / remaining, reset window, local token + credit meter
 *   /status  local API + login state
 *   /help    command list
 *
 * The first chat that messages the bot is bound to it; everything else is ignored.
 * The CLI injects collectUsage/collectStatus so this module stays testable.
 */
import { formatResetIn } from "./quota.mjs";
import { formatCompact } from "./usage_store.mjs";

export const TELEGRAM_API = "https://api.telegram.org";

export function telegramApiUrl(token, method) {
  return `${TELEGRAM_API}/bot${token}/${method}`;
}

/**
 * Call one Bot API method. Rethrows sanitized errors (never leaks the token in
 * logs or user-facing output).
 */
export async function tgCall(token, method, payload, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(telegramApiUrl(token, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  } catch (e) {
    throw new Error(String(e?.message || e).split(token).join("***"));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!data || data.ok !== true) {
    throw new Error(`telegram ${method}: ${data?.description || `HTTP ${res.status}`}`);
  }
  return data.result;
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fmtQuotaNumber = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
};

const fmtCredits = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return "0";
  if (v < 0.0001) return "<0.0001";
  return String(Math.round(v * 10000) / 10000);
};

const fmtDateTime = (ms) => {
  const d = new Date(Number(ms));
  if (!ms || Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** "/usage", "/usage@MyBot", "usage" → "usage". Returns null for other text. */
export function parseCommand(text) {
  const m = String(text || "").trim().match(/^\/?([a-zA-Z_]+)(?:@[\w_]+)?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  return ["start", "usage", "status", "help"].includes(cmd) ? cmd : null;
}

/**
 * Plain-text Telegram message for a collectUsage() result.
 * HTML parse mode: only <b> tags, everything else escaped.
 */
export function renderUsageText(data, { endpoint = data?.endpoint || "", label = data?.label || "Qoder CN" } = {}) {
  const lines = [`<b>${escapeHtml(label)} usage</b>`, ""];
  const account = data?.account;
  const accountError = data?.account_error;
  if (account?.displayMode === "enterprise") {
    lines.push("Plan: enterprise");
    lines.push("Usage is tracked in the Qoder console:");
    lines.push(escapeHtml(account.enterpriseUsage?.detailUrl || ""));
  } else if (account?.qoderUsage) {
    const u = account.qoderUsage;
    const q = u.userQuota;
    lines.push(`Plan: ${escapeHtml(u.userType || "?")}`);
    if (q) {
      const pct = (Number(u.totalUsagePercentage) || 0) * 100;
      lines.push(
        `Credits: ${fmtQuotaNumber(q.used)} / ${fmtQuotaNumber(q.total)} used (${pct.toFixed(1)}%)`
      );
      lines.push(`Remaining: ${fmtQuotaNumber(q.remaining)} ${escapeHtml(q.unit || "credits")}`);
    } else {
      lines.push(`Usage: ${((Number(u.totalUsagePercentage) || 0) * 100).toFixed(1)}% of plan`);
    }
    if (u.expiresAt) {
      lines.push(`Resets: ${fmtDateTime(u.expiresAt)} (${formatResetIn(u.expiresAt)})`);
    }
    if (u.isQuotaExceeded) lines.push("Quota exceeded — switch models or wait for the reset.");
  } else if (accountError) {
    lines.push(`Account: ${escapeHtml(accountError)}`);
  } else {
    lines.push("Account: not signed in — run  qoder-cn-infer login");
  }

  const t = data?.local?.totals;
  if (t) {
    lines.push("");
    lines.push("<b>Local meter (facade)</b>");
    lines.push(
      `${t.requests} requests · ${formatCompact(t.total_tokens)} tokens (${formatCompact(t.prompt_tokens)} in / ${formatCompact(t.completion_tokens)} out)`
    );
    lines.push(
      `${fmtCredits(t.credits)} credits · today ${formatCompact(data.local.today?.total_tokens || 0)} tokens · ${fmtCredits(data.local.today?.credits)} cr`
    );
  }
  if (endpoint) {
    lines.push("");
    lines.push(escapeHtml(endpoint));
  }
  return lines.join("\n");
}

export function renderStatusText(status, { endpoint = "" } = {}) {
  const lines = ["<b>qoder-cn-infer status</b>", ""];
  lines.push(`API: ${status?.running ? "running" : "not running"}`);
  lines.push(`Login: ${status?.login ? "signed in" : "missing"}`);
  if (status?.region) lines.push(`Region: ${escapeHtml(status.region)}${status?.label ? ` (${escapeHtml(status.label)})` : ""}`);
  if (endpoint) lines.push(escapeHtml(endpoint));
  return lines.join("\n");
}

export const COMMANDS_HELP =
  "Commands: /usage · /status · /help\n\n/usage shows your Qoder credits, the reset window, and the tokens this facade served.";

/**
 * Stateful bot core. `state` is a plain object persisted by the caller
 * ({ chat_id, offset }); persist() is called after every batch.
 */
export function createBot({
  token,
  state = {},
  persist = () => {},
  collectUsage,
  collectStatus,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  if (!token) throw new Error("telegram bot: token required");
  if (typeof collectUsage !== "function") throw new Error("telegram bot: collectUsage required");

  async function reply(chatId, text) {
    await tgCall(token, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, fetchImpl);
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg.text !== "string") return;
    const chatId = msg.chat?.id;
    if (chatId === undefined || chatId === null) return;
    const cmd = parseCommand(msg.text);

    // First contact binds the bot to that chat; anything else is ignored.
    if (state.chat_id === undefined || state.chat_id === null) {
      state.chat_id = chatId;
      const who = msg.from?.username ? ` (@${msg.from.username})` : "";
      log(`bound to chat ${chatId}${who}`);
      await reply(
        chatId,
        `Bound to this chat${escapeHtml(who)}.\n\n${COMMANDS_HELP}`
      );
      return;
    }
    if (chatId !== state.chat_id) {
      log(`ignored message from unbound chat ${chatId}`);
      return;
    }

    if (cmd === "usage") {
      const data = await collectUsage();
      await reply(chatId, renderUsageText(data, { endpoint: data?.endpoint || "" }));
      return;
    }
    if (cmd === "status") {
      const status = collectStatus ? await collectStatus() : {};
      await reply(chatId, renderStatusText(status, { endpoint: status?.endpoint || "" }));
      return;
    }
    if (cmd === "start" || cmd === "help") {
      await reply(chatId, COMMANDS_HELP);
      return;
    }
    await reply(chatId, COMMANDS_HELP);
  }

  /** Process one getUpdates batch. Exposed for tests; run() loops it. */
  async function pollOnce({ timeout = 50 } = {}) {
    const updates = await tgCall(token, "getUpdates", {
      offset: state.offset || 0,
      timeout,
      allowed_updates: ["message"],
    }, fetchImpl);
    let handled = 0;
    for (const update of updates || []) {
      if (typeof update.update_id === "number") state.offset = update.update_id + 1;
      if (update.message) {
        await handleMessage(update.message);
        handled += 1;
      }
    }
    if ((updates || []).length) persist();
    return handled;
  }

  async function run({ signal, backoffMs = 3000 } = {}) {
    while (!signal?.aborted) {
      try {
        await pollOnce();
      } catch (e) {
        log(`poll error: ${e.message}`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  /** One-shot push to the bound chat (for `telegram --report` / cron). */
  async function sendReport() {
    if (state.chat_id === undefined || state.chat_id === null) {
      throw new Error("no chat bound yet — message the bot once (or pass --chat <id>)");
    }
    const data = await collectUsage();
    await reply(state.chat_id, renderUsageText(data, { endpoint: data?.endpoint || "" }));
    return state.chat_id;
  }

  return { pollOnce, run, sendReport, state };
}
