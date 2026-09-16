/**
 * Load Qoder credentials per region: env PAT (region-specific names), the
 * stored PAT file, or the official CLI's saved login (~/.qoder-cn for CN,
 * ~/.qoder for global). Never starts the CLI.
 *
 * A token for one region never leaks into the other: CN and Qoder
 * International are separate services with separate accounts (the token
 * exchange rejects a cross-region PAT).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultHttpsRequest } from "./cn_cosy.mjs";
import {
  REGION_DEFS,
  cliLoginPaths,
  endpointsFor,
  normalizeRegion,
  storedPatPath,
} from "./regions.mjs";

export function decryptCliUserFile(authText, machineId) {
  const blob = Buffer.from(String(authText).trim(), "base64");
  const key = Buffer.from(String(machineId).trim().slice(0, 16), "utf8");
  const d = crypto.createDecipheriv("aes-128-cbc", key, key);
  const pt = Buffer.concat([d.update(blob), d.final()]).toString("utf8");
  return JSON.parse(pt);
}

export function loadCliLogin(home = os.homedir(), region = "cn") {
  const paths = cliLoginPaths(region, home);
  if (!fs.existsSync(paths.user) || !fs.existsSync(paths.machineId)) return null;
  const machineId = fs.readFileSync(paths.machineId, "utf8").trim();
  try {
    const creds = decryptCliUserFile(fs.readFileSync(paths.user, "utf8"), machineId);
    return { machineId, creds };
  } catch {
    // A damaged/unreadable login file must not take down the PAT path;
    // resolveIdentity then falls back to env PAT or stored PAT.
    return null;
  }
}

/** CN PAT path (back-compat export; region-aware path is storedPatPath()). */
export const STORED_PAT_PATH = path.join(
  os.homedir(),
  ".config",
  "qoder-cn-infer",
  "pat"
);

export function envPat(region = "cn") {
  const regionId = normalizeRegion(region);
  for (const name of REGION_DEFS[regionId].patEnvVars) {
    const env = (process.env[name] || "").trim();
    if (env) return env;
  }
  try {
    return fs.readFileSync(storedPatPath(regionId), "utf8").trim();
  } catch {
    return "";
  }
}

export async function exchangePat(pat, httpsRequest = defaultHttpsRequest, { region = "cn" } = {}) {
  const ep = endpointsFor(region);
  const res = await httpsRequest("POST", ep.jobTokenExchangeUrl, {
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ personal_token: pat }),
    timeout: 20000,
  });
  if (res.status !== 200) {
    throw new Error(
      `jobToken exchange HTTP ${res.status} (${ep.label} rejected the token; create one at ${ep.def.patHintUrl})`
    );
  }
  return JSON.parse(res.body);
}

export async function fetchUserinfo(jobToken, httpsRequest = defaultHttpsRequest, { region = "cn" } = {}) {
  const res = await httpsRequest("GET", endpointsFor(region).userinfoUrl, {
    headers: { authorization: `Bearer ${jobToken}`, accept: "application/json" },
    timeout: 20000,
  });
  if (res.status !== 200) {
    throw new Error(`userinfo HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

export async function resolveIdentity(
  httpsRequest = defaultHttpsRequest,
  { region = "cn", home = os.homedir() } = {}
) {
  const regionId = normalizeRegion(region);
  const def = REGION_DEFS[regionId];
  const login = loadCliLogin(home, regionId);
  const pat = envPat(regionId) || login?.creds?.personal_access_token || "";
  if (!pat && !login) {
    throw new Error(
      `No ${def.label} credentials: set ${def.patEnvVars.join(" / ")} or log in with ${def.cliName}`
    );
  }
  let jobToken = login?.creds?.security_oauth_token || login?.creds?.access_token;
  let refreshToken = login?.creds?.refresh_token || "";
  if (pat && (!jobToken || String(jobToken).length < 8)) {
    const ex = await exchangePat(pat, httpsRequest, { region: regionId });
    jobToken = ex.token;
    refreshToken = ex.refresh_token || refreshToken;
  }
  let uid = login?.creds?.uid || "";
  let name = login?.creds?.name || "";
  let userType = login?.creds?.user_type || "personal_standard";
  if (!uid && jobToken) {
    const info = await fetchUserinfo(jobToken, httpsRequest, { region: regionId });
    uid = info.id || "";
    name = info.name || name;
  }
  const machineId =
    login?.machineId || crypto.randomUUID();
  const machineToken = Buffer.from(
    crypto.randomBytes(25).toString("hex").slice(0, 50)
  ).toString("base64url");
  const machineType = crypto.randomBytes(9).toString("hex");
  return {
    region: regionId,
    pat,
    jobToken,
    refreshToken,
    identity: {
      name,
      aid: uid,
      uid,
      yx_uid: "",
      organization_id: "",
      organization_name: "",
      user_type: userType,
      security_oauth_token: jobToken,
      refresh_token: refreshToken,
    },
    machineId,
    machineToken,
    machineType,
  };
}
