/**
 * Qoder CN "claim" support — redeem promotional/activity credits the same way
 * qoderclicn's dynamic-command system does.
 *
 * How the official CLI does it (verified against qoderclicn 1.1.53):
 *   1. The server pushes a `dynamic_commands` feature gate (via
 *      POST {openapi}/api/v1/qcs/config/resolve + an SSE stream) containing
 *      command definitions. `/claim` only exists while such a definition is
 *      offered for the account (campaigns / activities).
 *   2. The definition carries `detail` endpoint(s) reporting
 *      `{data: [{activityId, canClaim}]}` and an `interaction` endpoint that
 *      claims one activity per call, with `query.activityId = <id>`.
 *   3. Endpoint templates use ${QODER_SESSION_ID}, ${QODER_COMMAND_NAME},
 *      ${QODER_DETAIL_JSON}; `domain` resolves inference/center -> gateway,
 *      openapi -> openapi host.
 *
 * When no definition is offered, this module reports that honestly — there is
 * nothing to claim and the official CLI shows the same (its /claim resolves to
 * "Unknown skill" in that state).
 */
import { CN_GATEWAY, CN_OPENAPI, defaultHttpsRequest } from "./cn_cosy.mjs";

export const QCS_RESOLVE_URL = `${CN_OPENAPI}/api/v1/qcs/config/resolve`;
export const CAMPAIGNS_URL = `${CN_OPENAPI}/sash/api/v1/me/campaigns`;
export const GATES_NAMESPACE = "qodercli-feature-gates";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function bearerOf(sess) {
  const token = sess?.identity?.security_oauth_token || "";
  if (!token) throw new Error("no security_oauth_token on session (sign in first)");
  return token;
}

async function postJson(url, token, body, httpsRequest) {
  return httpsRequest("POST", url, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    timeout: 20000,
  });
}

/** Fetch the CLI's feature-gate config; returns the namespace mapping ({} when empty). */
export async function fetchFeatureGates(sess, httpsRequest = defaultHttpsRequest) {
  const token = bearerOf(sess);
  const res = await postJson(
    QCS_RESOLVE_URL,
    token,
    { namespaces: [GATES_NAMESPACE], keys: [] },
    httpsRequest
  );
  if (res.status !== 200) {
    throw new Error(`qcs/config/resolve HTTP ${res.status}: ${String(res.body || "").slice(0, 160)}`);
  }
  const parsed = JSON.parse(res.body);
  const configs = parsed?.configs?.[GATES_NAMESPACE];
  return isObj(configs) ? configs : {};
}

export async function fetchCampaigns(sess, httpsRequest = defaultHttpsRequest) {
  const token = bearerOf(sess);
  const res = await httpsRequest("GET", CAMPAIGNS_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  if (res.status !== 200) {
    throw new Error(`campaigns HTTP ${res.status}`);
  }
  const parsed = JSON.parse(res.body);
  return {
    showCampaign: Boolean(pick(parsed, ["showCampaign"])),
    claimable: Boolean(pick(parsed, ["claimable"])),
    campaignUrl: String(pick(parsed, ["campaignUrl"]) ?? ""),
    count: Array.isArray(parsed?.campaigns) ? parsed.campaigns.length : 0,
  };
}

/**
 * The dynamic_commands gate value has the shape {commands: [definition, ...]}.
 * A "claim" definition is one named claim or carrying claim semantics.
 */
export function findClaimCommand(gates) {
  const raw = pick(gates || {}, ["dynamic_commands", "dynamicCommands"]);
  const value = isObj(raw) && "value" in raw ? raw.value : raw;
  const commands = isObj(value) && Array.isArray(value.commands) ? value.commands : [];
  for (const cmd of commands) {
    if (!isObj(cmd)) continue;
    const name = String(pick(cmd, ["name"]) ?? "");
    if (name === "claim" || pick(cmd, ["claimDisplay"]) !== undefined || cmd.requiresCanClaim === true) {
      return cmd;
    }
  }
  return null;
}

/** Endpoint domain aliases (same mapping the CLI's resolveDomain uses). */
export function resolveDomainBase(domain) {
  switch (String(domain || "").trim().toLowerCase()) {
    case "inference":
    case "center":
      return CN_GATEWAY;
    case "openapi":
      return CN_OPENAPI;
    default:
      return String(domain || "").replace(/\/+$/, "");
  }
}

export function substituteTemplate(text, ctx = {}) {
  return String(text)
    .replace(/\$\{QODER_SESSION_ID\}/g, ctx.sessionId ?? "")
    .replace(/\$\{QODER_COMMAND_NAME\}/g, ctx.commandName ?? "")
    .replace(
      /\$\{QODER_DETAIL_JSON\}/g,
      ctx.detail !== undefined ? JSON.stringify(ctx.detail) : ""
    );
}

function substituteDeep(value, ctx) {
  if (typeof value === "string") return substituteTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, ctx));
  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, ctx)]));
  }
  return value;
}

/**
 * Call one endpoint definition: {domain, path, method?, body?, params?, query?}.
 * Adds query.activityId when given (the CLI's withClaimActivityId transform).
 */
export async function callEndpoint(def, ctx, { activityId, httpsRequest = defaultHttpsRequest } = {}) {
  const base = resolveDomainBase(def.domain);
  const path = substituteTemplate(def.path || "", ctx);
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  const query = { ...(isObj(def.query) ? substituteDeep(def.query, ctx) : {}) };
  if (activityId !== undefined) query.activityId = activityId;
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const method = String(def.method || (def.body !== undefined ? "POST" : "GET")).toUpperCase();
  const bodyObj =
    def.body !== undefined ? substituteDeep(def.body, ctx) : method === "GET" ? undefined : substituteDeep(def.params ?? {}, ctx);
  return httpsRequest(method, url.toString(), {
    headers: {
      accept: "application/json",
      ...(bodyObj !== undefined ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${ctx.token}`,
    },
    body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
    timeout: 20000,
  });
}

/** {data:[{activityId, canClaim}]} → ids that can be claimed now. */
export function collectClaimableActivityIds(payloads) {
  const ids = [];
  for (const payload of payloads || []) {
    let data = null;
    try {
      data = typeof payload === "string" ? JSON.parse(payload) : payload;
    } catch {
      continue;
    }
    const rows = isObj(data) ? data.data : null;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isObj(row)) continue;
      const activityId = pick(row, ["activityId", "activity_id"]);
      if (typeof activityId === "string" && activityId.trim() && row.canClaim === true) {
        if (!ids.includes(activityId.trim())) ids.push(activityId.trim());
      }
    }
  }
  return ids;
}

function endpointList(def, key) {
  const v = def?.[key];
  if (Array.isArray(v)) return v.filter(isObj);
  if (isObj(v)) {
    return Array.isArray(v.endpoints) ? v.endpoints.filter(isObj) : [v];
  }
  return [];
}

async function fetchDetailPayloads(def, ctx, httpsRequest) {
  const endpoints = endpointList(def, "detail");
  const payloads = [];
  let detailCtx = undefined;
  for (const ep of endpoints) {
    const res = await callEndpoint(ep, { ...ctx, detail: detailCtx }, { httpsRequest });
    if (res.status === 200) {
      payloads.push(res.body);
      try {
        detailCtx = JSON.parse(res.body);
      } catch {
        detailCtx = undefined;
      }
    }
  }
  return payloads;
}

/**
 * Execute the claim for every claimable activity. Best-effort against the
 * server-delivered definition; every step's failure is reported, never hidden.
 */
export async function runClaim(def, sess, { sessionId = "", httpsRequest = defaultHttpsRequest, log = () => {} } = {}) {
  const ctx = {
    token: bearerOf(sess),
    sessionId,
    commandName: String(pick(def, ["name"]) ?? "claim"),
  };
  const detailPayloads = await fetchDetailPayloads(def, ctx, httpsRequest);
  const claimable = collectClaimableActivityIds(detailPayloads);
  if (!claimable.length) {
    return { ok: true, claimed: [], claimable: [], note: "nothing_claimable" };
  }
  const claimed = [];
  const errors = [];
  const interactions = endpointList(def, "interaction");
  if (!interactions.length) {
    return { ok: false, claimed, claimable: claimable, errors: ["definition has no interaction endpoint"] };
  }
  for (const activityId of claimable) {
    try {
      const res = await callEndpoint(interactions[0], ctx, { activityId, httpsRequest });
      if (res.status >= 200 && res.status < 300) {
        claimed.push(activityId);
      } else {
        errors.push(`${activityId}: HTTP ${res.status} ${String(res.body || "").slice(0, 120)}`);
      }
    } catch (e) {
      errors.push(`${activityId}: ${String(e?.message || e)}`);
    }
    log(`claim attempt ${activityId} done`);
  }
  return { ok: errors.length === 0, claimed, claimable, errors };
}

/**
 * One-call status used by the CLI / quick command.
 * Returns { offered, def, gates, campaigns, campaignsError }.
 */
export async function claimStatus(sess, httpsRequest = defaultHttpsRequest) {
  let gates = {};
  let gatesError = null;
  try {
    gates = await fetchFeatureGates(sess, httpsRequest);
  } catch (e) {
    gatesError = String(e?.message || e);
  }
  let campaigns = null;
  let campaignsError = null;
  try {
    campaigns = await fetchCampaigns(sess, httpsRequest);
  } catch (e) {
    campaignsError = String(e?.message || e);
  }
  const def = findClaimCommand(gates);
  return { offered: Boolean(def), def, gates, campaigns, gatesError, campaignsError };
}
