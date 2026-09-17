/**
 * Region tests: the cn/global endpoint tables, region resolution precedence,
 * per-region PAT storage/env precedence, region-aware auth/quota/claim URLs,
 * and CLI flags. Everything runs against stubs - zero real network calls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REGION_DEFS,
  cliLoginPaths,
  endpointsFor,
  normalizeRegion,
  parseRegion,
  resolveRegion,
  storedPatPath,
} from "../qoder4hermes_endpoint/regions.mjs";
import {
  CHAT_URL,
  MODEL_LIST_URL,
  CN_GATEWAY,
  CN_OPENAPI,
} from "../qoder4hermes_endpoint/cn_cosy.mjs";
import { envPat, exchangePat, fetchUserinfo, resolveIdentity } from "../qoder4hermes_endpoint/cn_auth.mjs";
import { fetchQuotaUsage, QUOTA_USAGE_URL } from "../qoder4hermes_endpoint/quota.mjs";
import {
  CAMPAIGNS_URL,
  QCS_RESOLVE_URL,
  resolveDomainBase,
  runClaim,
  fetchFeatureGates,
} from "../qoder4hermes_endpoint/claim.mjs";
import { formatUsagePlain, parseArgs } from "../bin/qoder4hermes.mjs";

const PAT_ENV_NAMES = [
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODER4HERMES_REGION",
  "QODER4HERMES_CONFIG_DIR",
  "QODER4HERMES_GLOBAL_INFER_HOST",
  // pre-rename names are still honored as fallbacks; keep the tests hermetic
  "QODER_CN_INFER_REGION",
  "QODER_CN_INFER_CONFIG_DIR",
  "QODER_CN_INFER_GLOBAL_INFER_HOST",
];

function withEnv(vars, fn) {
  const saved = {};
  for (const name of PAT_ENV_NAMES) saved[name] = process.env[name];
  for (const name of PAT_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const name of PAT_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function tmpDir(prefix = "qci-regions-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("endpointsFor(cn) matches the legacy CN constants byte for byte", () => {
  const ep = endpointsFor("cn");
  assert.equal(ep.chatUrl, CHAT_URL);
  assert.equal(ep.modelListUrl, MODEL_LIST_URL);
  assert.equal(ep.quotaUsageUrl, QUOTA_USAGE_URL);
  assert.equal(ep.jobTokenExchangeUrl, `${CN_OPENAPI}/api/v1/jobToken/exchange`);
  assert.equal(ep.inferBase, CN_GATEWAY);
  assert.equal(ep.centerBase, CN_GATEWAY);
  assert.equal(ep.label, "Qoder CN");
});

test("endpointsFor(global) uses the qoder.sh hosts with identical paths", () => {
  withEnv({}, () => {
    const ep = endpointsFor("global");
    assert.equal(ep.inferBase, "https://api2.qoder.sh");
    assert.equal(ep.centerBase, "https://center.qoder.sh");
    assert.equal(ep.openapiBase, "https://openapi.qoder.sh");
    assert.equal(
      ep.chatUrl,
      "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
    );
    assert.equal(ep.modelListUrl, "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1");
    assert.equal(ep.jobTokenExchangeUrl, "https://openapi.qoder.sh/api/v1/jobToken/exchange");
    assert.equal(ep.quotaUsageUrl, "https://openapi.qoder.sh/api/v2/quota/usage");
    assert.equal(ep.usagePresentationUrl, "https://openapi.qoder.sh/sash/api/v2/me/usage");
    assert.equal(ep.qcsResolveUrl, "https://openapi.qoder.sh/api/v1/qcs/config/resolve");
    assert.equal(ep.campaignsUrl, "https://openapi.qoder.sh/sash/api/v1/me/campaigns");
    assert.equal(ep.chatPath, "/api/v2/service/pro/sse/agent_chat_generation");
    assert.equal(ep.modelListPath, "/api/v2/model/list");
    assert.equal(ep.label, "Qoder");
  });
});

test("global inference host override: env wins, invalid values ignored, both paths identical", () => {
  withEnv({ QODER4HERMES_GLOBAL_INFER_HOST: "https://api1.qoder.sh" }, () => {
    assert.equal(endpointsFor("global").inferBase, "https://api1.qoder.sh");
  });
  withEnv({ QODER4HERMES_GLOBAL_INFER_HOST: "https://api3.qoder.sh/extra/path" }, () => {
    assert.equal(endpointsFor("global").inferBase, "https://api2.qoder.sh");
  });
  withEnv({ QODER4HERMES_GLOBAL_INFER_HOST: "http://insecure.example" }, () => {
    assert.equal(endpointsFor("global").inferBase, "https://api2.qoder.sh");
  });
  // The override never touches the CN region.
  withEnv({ QODER4HERMES_GLOBAL_INFER_HOST: "https://api1.qoder.sh" }, () => {
    assert.equal(endpointsFor("cn").inferBase, CN_GATEWAY);
  });
});

test("parseRegion/normalizeRegion accept aliases and reject typos", () => {
  assert.equal(parseRegion("cn"), "cn");
  assert.equal(parseRegion("global"), "global");
  assert.equal(parseRegion("INTL"), "global");
  assert.equal(parseRegion("international"), "global");
  assert.equal(parseRegion("glboal"), null);
  assert.equal(normalizeRegion("glboal"), "cn");
  assert.equal(normalizeRegion(undefined), "cn");
});

test("resolveRegion precedence: explicit → env → config.json → cn", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ region: "global" }));
  withEnv({ QODER4HERMES_CONFIG_DIR: dir }, () => {
    assert.equal(resolveRegion(), "global", "config.json region applies");
    assert.equal(resolveRegion("cn"), "cn", "explicit wins over config");
    process.env.QODER4HERMES_REGION = "cn";
    assert.equal(resolveRegion(), "cn", "env wins over config");
    assert.equal(resolveRegion("global"), "global", "explicit wins over env");
  });
  withEnv({}, () => assert.equal(resolveRegion(), "cn", "no signals → cn"));
});

test("PAT files and CLI login paths are per region", () => {
  const dir = tmpDir();
  withEnv({ QODER4HERMES_CONFIG_DIR: dir }, () => {
    assert.ok(storedPatPath("cn").endsWith(path.join(dir, "pat")));
    assert.ok(storedPatPath("global").endsWith(path.join(dir, "pat.global")));
    fs.writeFileSync(path.join(dir, "pat.global"), "pt-global-file\n");
    assert.equal(envPat("global"), "pt-global-file");
    assert.equal(envPat("cn"), "", "a global PAT file never answers for cn");
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-env";
    assert.equal(envPat("global"), "pt-global-env", "global env wins over the file");
    assert.equal(envPat("cn"), "", "the global env var never answers for cn");
  });
  const home = "/home/tester";
  assert.equal(cliLoginPaths("cn", home).user, path.join(home, ".qoder-cn", ".auth", "user"));
  assert.equal(cliLoginPaths("global", home).user, path.join(home, ".qoder", ".auth", "user"));
});

test("exchangePat and fetchUserinfo hit the openapi host of the region", async () => {
  const calls = [];
  const httpsRequest = async (method, url, opts) => {
    calls.push({ method, url, body: opts?.body });
    return { status: 200, body: JSON.stringify({ token: "jt-1", refresh_token: "rt-1" }) };
  };
  await exchangePat("pt-x", httpsRequest, { region: "global" });
  assert.equal(calls[0].url, "https://openapi.qoder.sh/api/v1/jobToken/exchange");
  assert.deepEqual(JSON.parse(calls[0].body), { personal_token: "pt-x" });
  await exchangePat("pt-x", httpsRequest, { region: "cn" });
  assert.equal(calls[1].url, `${CN_OPENAPI}/api/v1/jobToken/exchange`);

  const calls2 = [];
  const httpsRequest2 = async (m, url) => {
    calls2.push(url);
    return { status: 200, body: JSON.stringify({ id: "u1", name: "n" }) };
  };
  await fetchUserinfo("jt-1", httpsRequest2, { region: "global" });
  assert.equal(calls2[0], "https://openapi.qoder.sh/api/v1/userinfo");
});

test("exchangePat surfaces the rejected-token hint with the region's token URL", async () => {
  const httpsRequest = async () => ({ status: 400, body: '{"errorCode":"BadRequest"}' });
  await assert.rejects(
    exchangePat("pt-cn-token", httpsRequest, { region: "global" }),
    /Qoder rejected the token.*qoder\.com\/account\/integrations/
  );
  await assert.rejects(
    exchangePat("pt-bogus", httpsRequest, { region: "cn" }),
    /Qoder CN rejected the token.*qoder\.cn\/account\/integrations/
  );
});

test("resolveIdentity(global) exchanges the global env PAT and only talks to qoder.sh", async () => {
  await withEnvAsync(
    { QODER_PERSONAL_ACCESS_TOKEN: "pt-global-env", QODER4HERMES_CONFIG_DIR: tmpDir() },
    async () => {
    const calls = [];
    const stub = async (method, url) => {
      calls.push(url);
      if (url.includes("jobToken/exchange")) {
        return { status: 200, body: JSON.stringify({ token: "jt-9", refresh_token: "rt-9" }) };
      }
      if (url.includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ id: "u-9", name: "Tester" }) };
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const id = await resolveIdentity(stub, { region: "global", home: tmpDir() });
    assert.equal(id.region, "global");
    assert.equal(id.pat, "pt-global-env");
    assert.equal(id.jobToken, "jt-9");
    assert.equal(id.identity.uid, "u-9");
    assert.deepEqual(calls, [
      "https://openapi.qoder.sh/api/v1/jobToken/exchange",
      "https://openapi.qoder.sh/api/v1/userinfo",
    ]);
  });
});

test("resolveIdentity(cn) never picks up the global env var", async () => {
  await withEnvAsync(
    { QODER_PERSONAL_ACCESS_TOKEN: "pt-global-env", QODER4HERMES_CONFIG_DIR: tmpDir() },
    async () => {
    try {
      const id = await resolveIdentity(async () => ({ status: 500, body: "" }), {
        region: "cn",
        home: tmpDir(),
      });
      // Allowed only if some genuinely CN source answered - never the global env value.
      assert.notEqual(id.pat, "pt-global-env");
    } catch (e) {
      assert.match(String(e?.message || e), /No Qoder CN credentials/);
    }
  });
});

test("fetchQuotaUsage honors the region for the quota endpoint", async () => {
  const sess = { identity: { security_oauth_token: "jt-x" } };
  const calls = [];
  const httpsRequest = async (m, url) => {
    calls.push(url);
    return { status: 200, body: JSON.stringify({ userId: "u", userType: "t" }) };
  };
  const out = await fetchQuotaUsage(sess, httpsRequest, { region: "global" });
  assert.equal(out.userId, "u");
  assert.equal(calls[0], "https://openapi.qoder.sh/api/v2/quota/usage");
});

test("claim endpoints and domain aliases follow the region", async () => {
  assert.equal(resolveDomainBase("inference", "global"), "https://api2.qoder.sh");
  assert.equal(resolveDomainBase("center", "global"), "https://center.qoder.sh");
  assert.equal(resolveDomainBase("openapi", "global"), "https://openapi.qoder.sh");
  assert.equal(resolveDomainBase("inference"), CN_GATEWAY);
  assert.equal(resolveDomainBase("center"), CN_GATEWAY);
  assert.equal(resolveDomainBase("openapi"), CN_OPENAPI);

  const calls = [];
  const httpsRequest = async (method, url) => {
    calls.push(url);
    if (url.includes("qcs/config/resolve")) {
      return { status: 200, body: JSON.stringify({ configs: { "qodercli-feature-gates": {} } }) };
    }
    return { status: 200, body: JSON.stringify({ showCampaign: false, claimable: false, campaigns: [] }) };
  };
  const sess = { identity: { security_oauth_token: "jt-x" } };
  await fetchFeatureGates(sess, httpsRequest, { region: "global" });
  assert.equal(calls[0], "https://openapi.qoder.sh/api/v1/qcs/config/resolve");
  assert.equal(QCS_RESOLVE_URL, `${CN_OPENAPI}/api/v1/qcs/config/resolve`, "CN const unchanged");
  assert.equal(CAMPAIGNS_URL, `${CN_OPENAPI}/sash/api/v1/me/campaigns`, "CN const unchanged");

  const claimCalls = [];
  const claimStub = async (method, url) => {
    claimCalls.push({ method, url });
    if (url.includes("/claim/detail")) {
      return { status: 200, body: JSON.stringify({ data: [{ activityId: "act-1", canClaim: true }] }) };
    }
    return { status: 200, body: JSON.stringify({ code: "ok" }) };
  };
  const def = {
    name: "claim",
    detail: [{ domain: "openapi", path: "/sash/api/v1/me/claim/detail", method: "GET" }],
    interaction: [{ domain: "openapi", path: "/sash/api/v1/me/claim/redeem", method: "POST", body: {} }],
  };
  const result = await runClaim(def, sess, { httpsRequest: claimStub, region: "global" });
  assert.deepEqual(result.claimed, ["act-1"]);
  assert.match(claimCalls[0].url, /^https:\/\/openapi\.qoder\.sh\//);
});

test("parseArgs understands --region", () => {
  const a = parseArgs(["login", "--region", "global", "--pat", "--token", "pt-x"]);
  assert.equal(a.region, "global");
  assert.equal(a.pat, true);
  const b = parseArgs(["usage", "--region=cn"]);
  assert.equal(b.region, "cn");
  const c = parseArgs(["usage"]);
  assert.equal(c.region, "");
});

test("formatUsagePlain labels the account by region", () => {
  const data = {
    account: {
      displayMode: "qoder",
      qoderUsage: {
        userType: "personal_professional_trial",
        totalUsagePercentage: 0.3,
        expiresAt: 1789967681429,
        isQuotaExceeded: false,
        userQuota: { used: 87, total: 300, remaining: 213, unit: "credits" },
      },
    },
    local: null,
    source: "direct",
    endpoint: "http://127.0.0.1:8787/v1",
  };
  assert.match(formatUsagePlain(data), /Qoder CN credits: 87\/300/);
  assert.match(formatUsagePlain({ ...data, label: "Qoder" }), /Qoder credits: 87\/300/);
});

test("region definitions carry the documented env vars and token URLs", () => {
  assert.deepEqual(REGION_DEFS.cn.patEnvVars, ["QODERCN_PERSONAL_ACCESS_TOKEN", "QODER_PAT"]);
  assert.deepEqual(REGION_DEFS.global.patEnvVars, ["QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"]);
  assert.equal(REGION_DEFS.cn.patHintUrl, "https://qoder.cn/account/integrations");
  assert.equal(REGION_DEFS.global.patHintUrl, "https://qoder.com/account/integrations");
  assert.equal(REGION_DEFS.cn.cliName, "qoderclicn");
  assert.equal(REGION_DEFS.global.cliName, "qodercli");
});

// async variant of withEnv (installed as a helper above the first use)
async function withEnvAsync(vars, fn) {
  const saved = {};
  for (const name of PAT_ENV_NAMES) saved[name] = process.env[name];
  for (const name of PAT_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const name of PAT_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}
