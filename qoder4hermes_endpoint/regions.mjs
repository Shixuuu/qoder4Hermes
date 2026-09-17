/**
 * Region table for the facade: `cn` (Qoder CN, the default) and `global`
 * (Qoder International). Both deployments run the same gateway protocol -
 * identical paths, identical COSY signing - only the hosts and the
 * credentials differ.
 *
 * global hosts mirror qodercli's own built-in production defaults
 * (inference api2.qoder.sh, center center.qoder.sh, openapi openapi.qoder.sh).
 * The official CLI may elect a different api1/api2/api3 host for a network
 * and caches that for 24h; the facade stays on the documented default and
 * takes an explicit override (QODER4HERMES_GLOBAL_INFER_HOST) instead of
 * replicating the election.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CN_GATEWAY, CN_OPENAPI, CHAT_PATH, MODEL_LIST_PATH } from "./cn_cosy.mjs";

export const REGION_DEFS = {
  cn: {
    id: "cn",
    label: "Qoder CN",
    cliName: "qoderclicn",
    inferBase: CN_GATEWAY,
    centerBase: CN_GATEWAY,
    openapiBase: CN_OPENAPI,
    patEnvVars: ["QODERCN_PERSONAL_ACCESS_TOKEN", "QODER_PAT"],
    patFileName: "pat",
    cliAuthDir: [".qoder-cn", ".auth"],
    patHintUrl: "https://qoder.cn/account/integrations",
  },
  global: {
    id: "global",
    label: "Qoder",
    cliName: "qodercli",
    inferBase: "https://api2.qoder.sh",
    centerBase: "https://center.qoder.sh",
    openapiBase: "https://openapi.qoder.sh",
    patEnvVars: ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"],
    patFileName: "pat.global",
    cliAuthDir: [".qoder", ".auth"],
    patHintUrl: "https://qoder.com/account/integrations",
  },
};

export function configDir() {
  const env = process.env.QODER4HERMES_CONFIG_DIR || process.env.QODER_CN_INFER_CONFIG_DIR;
  if (env) return env;
  const current = path.join(os.homedir(), ".config", "qoder4hermes");
  const legacy = path.join(os.homedir(), ".config", "qoder-cn-infer");
  if (fs.existsSync(current)) return current;
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

function readConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** "cn" | "global" | null for anything else (intl/international are aliases). */
export function parseRegion(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "cn" || v === "china") return "cn";
  if (v === "global" || v === "intl" || v === "international") return "global";
  return null;
}

export function normalizeRegion(value, fallback = "cn") {
  return parseRegion(value) ?? fallback;
}

/**
 * Region in effect for this process: a model token per region never leaks
 * into the other one, so this is the single source every module resolves.
 *   explicit arg → QODER4HERMES_REGION → config.json `region` → "cn"
 */
export function resolveRegion(explicit = "") {
  return (
    parseRegion(explicit) ||
    parseRegion(process.env.QODER4HERMES_REGION || process.env.QODER_CN_INFER_REGION) ||
    parseRegion(readConfigSafe().region) ||
    "cn"
  );
}

/** PAT file for a region: `pat` (cn) / `pat.global` (global). */
export function storedPatPath(region) {
  return path.join(configDir(), REGION_DEFS[normalizeRegion(region)].patFileName);
}

/** Login-state file paths of the official CLI for a region. */
export function cliLoginPaths(region, home = os.homedir()) {
  const [dir, sub] = REGION_DEFS[normalizeRegion(region)].cliAuthDir;
  const base = path.join(home, dir, sub);
  return { user: path.join(base, "user"), machineId: path.join(base, "machine_id") };
}

/** An https origin with no path/credentials/query, or null. */
function httpsOrigin(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.pathname !== "/" && u.pathname !== "") return null;
    if (u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Inference host for the global region: api2.qoder.sh by default, overridden
 * by QODER4HERMES_GLOBAL_INFER_HOST or config.json `global_infer_host`
 * (https origin only; invalid values are ignored, like the CLI does).
 */
export function globalInferBase() {
  return (
    httpsOrigin(process.env.QODER4HERMES_GLOBAL_INFER_HOST || process.env.QODER_CN_INFER_GLOBAL_INFER_HOST) ||
    httpsOrigin(readConfigSafe().global_infer_host) ||
    REGION_DEFS.global.inferBase
  );
}

/**
 * Everything network-facing for a region. Paths are identical across regions
 * (same gateway protocol); only the hosts change. CN URLs are built from the
 * same constants the CN module has always used, so nothing moves for CN.
 */
export function endpointsFor(regionInput) {
  const region = normalizeRegion(regionInput);
  const def = REGION_DEFS[region];
  const inferBase = region === "global" ? globalInferBase() : def.inferBase;
  return {
    region,
    label: def.label,
    def,
    inferBase,
    centerBase: def.centerBase,
    openapiBase: def.openapiBase,
    chatPath: CHAT_PATH,
    modelListPath: MODEL_LIST_PATH,
    chatUrl: `${inferBase}/algo${CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
    modelListUrl: `${inferBase}/algo${MODEL_LIST_PATH}?Encode=1`,
    jobTokenExchangeUrl: `${def.openapiBase}/api/v1/jobToken/exchange`,
    jobTokenRefreshUrl: `${def.openapiBase}/api/v1/jobToken/refresh`,
    userinfoUrl: `${def.openapiBase}/api/v1/userinfo`,
    quotaUsageUrl: `${def.openapiBase}/api/v2/quota/usage`,
    usagePresentationUrl: `${def.openapiBase}/sash/api/v2/me/usage`,
    qcsResolveUrl: `${def.openapiBase}/api/v1/qcs/config/resolve`,
    campaignsUrl: `${def.openapiBase}/sash/api/v1/me/campaigns`,
  };
}
