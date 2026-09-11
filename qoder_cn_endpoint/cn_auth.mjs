/**
 * Load CN credentials from env PAT or ~/.qoder-cn CLI login. Never starts the CLI.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JOBTOKEN_EXCHANGE_URL,
  USERINFO_URL,
  defaultHttpsRequest,
} from "./cn_cosy.mjs";

export function decryptCliUserFile(authText, machineId) {
  const blob = Buffer.from(String(authText).trim(), "base64");
  const key = Buffer.from(String(machineId).trim().slice(0, 16), "utf8");
  const d = crypto.createDecipheriv("aes-128-cbc", key, key);
  const pt = Buffer.concat([d.update(blob), d.final()]).toString("utf8");
  return JSON.parse(pt);
}

export function loadCliLogin(home = os.homedir()) {
  const authPath = path.join(home, ".qoder-cn", ".auth", "user");
  const midPath = path.join(home, ".qoder-cn", ".auth", "machine_id");
  if (!fs.existsSync(authPath) || !fs.existsSync(midPath)) return null;
  const machineId = fs.readFileSync(midPath, "utf8").trim();
  const creds = decryptCliUserFile(fs.readFileSync(authPath, "utf8"), machineId);
  return { machineId, creds };
}

export function envPat() {
  return (
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN ||
    process.env.QODER_PAT ||
    ""
  ).trim();
}

export async function exchangePat(pat, httpsRequest = defaultHttpsRequest) {
  const res = await httpsRequest("POST", JOBTOKEN_EXCHANGE_URL, {
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ personal_token: pat }),
    timeout: 20000,
  });
  if (res.status !== 200) {
    throw new Error(`jobToken exchange HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

export async function fetchUserinfo(jobToken, httpsRequest = defaultHttpsRequest) {
  const res = await httpsRequest("GET", USERINFO_URL, {
    headers: { authorization: `Bearer ${jobToken}`, accept: "application/json" },
    timeout: 20000,
  });
  if (res.status !== 200) {
    throw new Error(`userinfo HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

export async function resolveIdentity(httpsRequest = defaultHttpsRequest) {
  const login = loadCliLogin();
  const pat = envPat() || login?.creds?.personal_access_token || "";
  if (!pat && !login) {
    throw new Error(
      "No CN credentials: set QODERCN_PERSONAL_ACCESS_TOKEN / QODER_PAT or qoderclicn login"
    );
  }
  let jobToken = login?.creds?.security_oauth_token || login?.creds?.access_token;
  let refreshToken = login?.creds?.refresh_token || "";
  if (pat && (!jobToken || String(jobToken).length < 8)) {
    const ex = await exchangePat(pat, httpsRequest);
    jobToken = ex.token;
    refreshToken = ex.refresh_token || refreshToken;
  }
  let uid = login?.creds?.uid || "";
  let name = login?.creds?.name || "";
  let userType = login?.creds?.user_type || "personal_standard";
  if (!uid && jobToken) {
    const info = await fetchUserinfo(jobToken, httpsRequest);
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
