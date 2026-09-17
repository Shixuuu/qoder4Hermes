/**
 * Qoder CN account usage/quota — same endpoints qoderclicn reads.
 *
 *   GET {openapi}/api/v2/quota/usage    → credits balance for personal accounts
 *   GET {openapi}/sash/api/v2/me/usage  → usage presentation (enterprise link / credits)
 *
 * Auth is the login's security_oauth_token as a Bearer header, exactly like the CLI.
 * Never spawns a process; safe for the facade to call on every /usage request.
 */
import { CN_OPENAPI, defaultHttpsRequest } from "./cn_cosy.mjs";
import { endpointsFor } from "./regions.mjs";

export const QUOTA_USAGE_URL = `${CN_OPENAPI}/api/v2/quota/usage`;
export const USAGE_PRESENTATION_URL = `${CN_OPENAPI}/sash/api/v2/me/usage`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** First defined value among alternate key spellings (CLI accepts snake_case + camelCase). */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** One credits bucket: {total, used, remaining, percentage, unit}. */
export function normalizeQuotaBucket(raw) {
  if (!isObj(raw)) return undefined;
  const total = num(pick(raw, ["total"]));
  const used = num(pick(raw, ["used"]));
  const remainingRaw = num(pick(raw, ["remaining"]));
  if (total === undefined && used === undefined && remainingRaw === undefined) {
    return undefined;
  }
  const totalN = total ?? 0;
  const usedN = used ?? 0;
  const remaining = remainingRaw ?? Math.max(totalN - usedN, 0);
  const percentage =
    clamp01(num(pick(raw, ["percentage"]))) ??
    (totalN > 0 ? clamp01(usedN / totalN) : undefined);
  return {
    total: totalN,
    used: usedN,
    remaining,
    percentage,
    unit: String(pick(raw, ["unit"]) ?? "credits"),
  };
}

/** Dedicated resource packages (team/org seats): keep id/name plus the bucket. */
function normalizeDedicatedPackages(raw, requireAny) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const id = String(pick(item, ["id"]) ?? "").trim();
    if (!id) continue;
    const bucket = normalizeQuotaBucket(item);
    if (!bucket && !requireAny) continue;
    const entry = { id, name: String(pick(item, ["name"]) ?? "").trim() };
    const description = pick(item, ["description", "desc"]);
    if (description) entry.description = String(description).trim();
    if (bucket) Object.assign(entry, bucket);
    const expiresAt = num(pick(item, ["expires_at", "expiresAt"]));
    if (expiresAt !== undefined) entry.expiresAt = expiresAt;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

/**
 * Normalize the /api/v2/quota/usage payload. Returns null when the payload is not
 * a recognizable quota document (mirrors the CLI's validity checks).
 */
export function normalizeQuotaUsage(raw) {
  if (!isObj(raw)) return null;
  const userId = pick(raw, ["user_id", "userId"]);
  const userType = pick(raw, ["user_type", "userType"]);
  if (!userId || !userType) return null;

  const totalUsagePercentage =
    clamp01(num(pick(raw, ["total_usage_percentage", "totalUsagePercentage"]))) ?? 0;
  const isQuotaExceededRaw = pick(raw, ["is_quota_exceeded", "isQuotaExceeded"]);

  const out = {
    userId: String(userId),
    userType: String(userType),
    usageType: "credits",
    totalUsagePercentage,
    isQuotaExceeded:
      typeof isQuotaExceededRaw === "boolean"
        ? isQuotaExceededRaw
        : totalUsagePercentage >= 1,
    expiresAt: num(pick(raw, ["expires_at", "expiresAt"])) ?? 0,
    upgradeUrl: String(pick(raw, ["upgrade_url", "upgradeUrl"]) ?? ""),
  };
  if (String(pick(raw, ["usageType"])) === "credits") out.usageType = "credits";

  const userQuota = normalizeQuotaBucket(raw.user_quota ?? raw.userQuota);
  if (userQuota) out.userQuota = userQuota;

  const prorated = pick(raw, ["is_plan_quota_prorated", "isPlanQuotaProrated"]);
  if (typeof prorated === "boolean") out.isPlanQuotaProrated = prorated;

  const addOnRaw = raw.add_on_quota ?? raw.addOnQuota;
  if (isObj(addOnRaw)) {
    const bucket = normalizeQuotaBucket(addOnRaw);
    if (bucket) {
      out.addOnQuota = {
        ...bucket,
        detailUrl: String(pick(addOnRaw, ["detail_url", "detailUrl"]) ?? ""),
      };
    }
  }

  const orgRaw =
    raw.org_resource_package ??
    raw.orgResourcePackage ??
    raw.shared_quota ??
    raw.sharedQuota;
  if (isObj(orgRaw)) {
    const used = num(pick(orgRaw, ["used"])) ?? 0;
    const cap = num(pick(orgRaw, ["cap", "total"])) ?? 0;
    const remaining = num(pick(orgRaw, ["remaining"])) ?? Math.max(cap - used, 0);
    out.orgResourcePackage = {
      used,
      cap,
      remaining,
      percentage:
        clamp01(num(pick(orgRaw, ["percentage"]))) ??
        (cap > 0 ? clamp01(used / cap) : undefined),
      available: Boolean(pick(orgRaw, ["available"])) || cap > 0,
      unit: String(pick(orgRaw, ["unit"]) ?? "credits"),
    };
  }

  const dedicated = normalizeDedicatedPackages(
    raw.dedicated_resource_packages ?? raw.dedicatedResourcePackages,
    true
  );
  if (dedicated) out.dedicatedResourcePackages = dedicated;

  return out;
}

function bearerOf(sess) {
  const token = sess?.identity?.security_oauth_token || "";
  if (!token) throw new Error("no security_oauth_token on session (sign in first)");
  return token;
}

async function getJson(url, token, httpsRequest) {
  return httpsRequest("GET", url, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    timeout: 20000,
  });
}

export async function fetchQuotaUsage(sess, httpsRequest = defaultHttpsRequest, opts = {}) {
  const token = bearerOf(sess);
  const res = await getJson(endpointsFor(opts.region).quotaUsageUrl, token, httpsRequest);
  if (res.status === 401) {
    const err = new Error("quota HTTP 401 — login expired, run  qoder4hermes login");
    err.status = 401;
    throw err;
  }
  if (res.status !== 200) {
    const err = new Error(`quota HTTP ${res.status}: ${String(res.body || "").slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const norm = normalizeQuotaUsage(JSON.parse(res.body));
  if (!norm) throw new Error("quota response missing userId/userType");
  return norm;
}

/**
 * Usage presentation for org accounts; personal accounts get their credits quota.
 * Returns {displayMode:"qoder", qoderUsage} or {displayMode:"enterprise", enterpriseUsage}.
 * Never throws for the personal path shape: falls back to /api/v2/quota/usage.
 */
export async function fetchUsagePresentation(sess, httpsRequest = defaultHttpsRequest, opts = {}) {
  const orgId = sess?.identity?.organization_id || "";
  if (!orgId) {
    return { displayMode: "qoder", qoderUsage: await fetchQuotaUsage(sess, httpsRequest, opts) };
  }
  try {
    const token = bearerOf(sess);
    const res = await getJson(endpointsFor(opts.region).usagePresentationUrl, token, httpsRequest);
    if (res.status === 200) {
      const raw = JSON.parse(res.body);
      const displayMode = pick(raw, ["displayMode"]);
      if (displayMode === "qoder" && isObj(raw.qoderUsage)) {
        const quota = normalizeQuotaUsage(raw.qoderUsage);
        if (quota) return { displayMode: "qoder", qoderUsage: quota };
      } else if (displayMode === "enterprise" && isObj(raw.enterpriseUsage)) {
        const e = raw.enterpriseUsage;
        const detailUrl = pick(e, ["detailUrl"]);
        const openMode = pick(e, ["openMode"]);
        const fallbackUrl = pick(e, ["fallbackUrl"]);
        if (
          typeof detailUrl === "string" &&
          (openMode === "externalBrowser" || openMode === "systemDeepLink")
        ) {
          const entry = { openMode, detailUrl };
          if (typeof fallbackUrl === "string" && fallbackUrl) entry.fallbackUrl = fallbackUrl;
          return { displayMode: "enterprise", enterpriseUsage: entry };
        }
      }
    }
  } catch {
    /* fall through to the credits quota */
  }
  return { displayMode: "qoder", qoderUsage: await fetchQuotaUsage(sess, httpsRequest, opts) };
}

/** Unified entry point used by /usage and the CLI. */
export async function fetchAccountUsage(sess, httpsRequest = defaultHttpsRequest, opts = {}) {
  const pres = await fetchUsagePresentation(sess, httpsRequest, opts);
  return { ...pres, fetchedAt: Date.now() };
}

/** Human reset estimate, e.g. "in 4d 23h". */
export function formatResetIn(expiresAt, now = Date.now()) {
  if (!expiresAt || expiresAt <= 0) return "";
  const ms = expiresAt - now;
  if (ms <= 0) return "reset due";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}
