/**
 * CN gateway request encoding + COSY headers.
 * Same hosts/paths qoderclicn uses internally; no CLI process.
 */
import crypto from "node:crypto";
import https from "node:https";

export const CN_GATEWAY = "https://gateway.qoder.com.cn";
export const CN_OPENAPI = "https://openapi.qoder.com.cn";
export const MODEL_LIST_PATH = "/api/v2/model/list";
export const MODEL_LIST_URL = `${CN_GATEWAY}/algo${MODEL_LIST_PATH}?Encode=1`;
export const CHAT_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const CHAT_URL =
  `${CN_GATEWAY}/algo${CHAT_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const JOBTOKEN_EXCHANGE_URL = `${CN_OPENAPI}/api/v1/jobToken/exchange`;
export const JOBTOKEN_REFRESH_URL = `${CN_OPENAPI}/api/v1/jobToken/refresh`;
export const USERINFO_URL = `${CN_OPENAPI}/api/v1/userinfo`;

const CUSTOM_ALPHABET =
  "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const S2C = Object.fromEntries(
  [...STD_ALPHABET].map((ch, i) => [ch, CUSTOM_ALPHABET[i]])
);
S2C["="] = "$";
const C2S = Object.fromEntries(
  [...CUSTOM_ALPHABET].map((ch, i) => [ch, STD_ALPHABET[i]])
);
C2S["$"] = "=";

const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export function qoderEncode(plain) {
  const bytes = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  const std = bytes.toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return [...rearranged].map((ch) => S2C[ch]).join("");
}

export function qoderDecode(encoded) {
  const n = encoded.length;
  const a = Math.floor(n / 3);
  const mapped = [...encoded].map((ch) => C2S[ch] ?? ch).join("");
  const std = mapped.slice(n - a) + mapped.slice(a, n - a) + mapped.slice(0, a);
  return Buffer.from(std, "base64");
}

function md5hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

function aesCbcEncrypt(plain, key) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function rsaEncrypt(buf) {
  return crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    buf
  );
}

export function buildSession(identity, machineId, machineToken, machineType) {
  const tempBuf = Buffer.from(crypto.randomBytes(8).toString("hex"), "ascii");
  const cosyKey = rsaEncrypt(tempBuf).toString("base64");
  const infoObj = {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yx_uid || "",
    organization_id: identity.organization_id || "",
    organization_name: identity.organization_name || "",
    user_type: identity.user_type,
    security_oauth_token: identity.security_oauth_token,
    refresh_token: identity.refresh_token,
  };
  const info = aesCbcEncrypt(Buffer.from(JSON.stringify(infoObj)), tempBuf).toString(
    "base64"
  );
  return { cosyKey, info, identity, machineId, machineToken, machineType };
}

function buildPayloadB64(info) {
  const m = {
    cosyVersion: "0.1.43",
    ideVersion: "",
    info,
    requestId: crypto.randomUUID(),
    version: "v1",
  };
  const sorted = Object.fromEntries(
    Object.entries(m).sort(([a], [b]) => a.localeCompare(b))
  );
  return Buffer.from(JSON.stringify(sorted)).toString("base64");
}

export function signRequest(payloadB64, cosyKey, cosyDate, body, pathWithoutAlgo) {
  return md5hex(
    `${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathWithoutAlgo}`
  );
}

export function cosyHeaders(sess, { date, body, pathWithoutAlgo, accept }) {
  const payloadB64 = buildPayloadB64(sess.info);
  const sig = signRequest(payloadB64, sess.cosyKey, date, body, pathWithoutAlgo);
  return {
    "cosy-data-policy": "AGREE",
    "content-type": "application/json",
    "cosy-machinetype": sess.machineType,
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": sess.identity.uid,
    "cosy-key": sess.cosyKey,
    accept,
    authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "accept-encoding": "identity",
    "cosy-version": "0.1.43",
    "cosy-machineid": sess.machineId,
    "cosy-machinetoken": sess.machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
  };
}

export function defaultHttpsRequest(method, urlStr, { headers, body, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Streaming HTTPS: resolve { status, lines() } so callers can flush SSE as it arrives. */
export function defaultHttpsStream(method, urlStr, { headers, body, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
        timeout,
      },
      (res) => {
        async function* lines() {
          let buf = "";
          for await (const chunk of res) {
            buf += chunk.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, "");
              buf = buf.slice(nl + 1);
              yield line;
            }
          }
          if (buf) yield buf.replace(/\r$/, "");
        }
        resolve({ status: res.statusCode, lines });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

export function httpsStreamFromBuffered(httpsRequest) {
  return async (method, url, opts) => {
    const res = await httpsRequest(method, url, opts);
    const raw = String(res.body || "");
    const parts = raw.split(/\n/).map((l) => l.replace(/\r$/, ""));
    return {
      status: res.status,
      async *lines() {
        for (const line of parts) yield line;
      },
    };
  };
}
