/**
 * Claim tests: feature-gate parsing, activity extraction, the def-driven claim
 * executor (against a synthetic server definition), and the not-offered path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  claimStatus,
  collectClaimableActivityIds,
  fetchCampaigns,
  fetchFeatureGates,
  findClaimCommand,
  resolveDomainBase,
  runClaim,
  substituteTemplate,
  CAMPAIGNS_URL,
  QCS_RESOLVE_URL,
} from "../qoder_cn_endpoint/claim.mjs";

const SESS = {
  identity: { security_oauth_token: "jt-x", uid: "u1", user_type: "personal_standard" },
};

test("findClaimCommand finds a claim definition and ignores empty gates", () => {
  assert.equal(findClaimCommand({}), null);
  assert.equal(findClaimCommand({ dynamic_commands: { value: { commands: [] } } }), null);
  const def = { name: "claim", claimDisplay: true, interaction: [] };
  assert.equal(
    findClaimCommand({ dynamic_commands: { value: { commands: [{ name: "other" }, def] } } }),
    def
  );
  // requiresCanClaim alone also marks a claim command
  const def2 = { name: "redeem", requiresCanClaim: true };
  assert.equal(findClaimCommand({ dynamic_commands: { commands: [def2] } }), def2);
});

test("resolveDomainBase maps CLI domain aliases to real hosts", () => {
  assert.match(resolveDomainBase("inference"), /^https:\/\/gateway\.qoder\.com\.cn$/);
  assert.match(resolveDomainBase("center"), /^https:\/\/gateway\.qoder\.com\.cn$/);
  assert.match(resolveDomainBase("openapi"), /^https:\/\/openapi\.qoder\.com\.cn$/);
  assert.equal(resolveDomainBase("https://example.com/"), "https://example.com");
});

test("substituteTemplate replaces the QODER_* placeholders", () => {
  const out = substituteTemplate(
    "/x/${QODER_SESSION_ID}/y/${QODER_COMMAND_NAME}/z/${QODER_DETAIL_JSON}",
    { sessionId: "s1", commandName: "claim", detail: { a: 1 } }
  );
  assert.equal(out, '/x/s1/y/claim/z/{"a":1}');
});

test("collectClaimableActivityIds picks only canClaim rows", () => {
  const ids = collectClaimableActivityIds([
    JSON.stringify({
      data: [
        { activityId: "a", canClaim: true },
        { activityId: "b", canClaim: false },
        { activityId: "a", canClaim: true },
      ],
    }),
    { data: [{ activity_id: "c", canClaim: true }] },
  ]);
  assert.deepEqual(ids, ["a", "c"]);
});

test("fetchFeatureGates posts to qcs/config/resolve with Bearer auth", async () => {
  const calls = [];
  const httpsRequest = async (method, url, opts) => {
    calls.push({ method, url, headers: opts.headers, body: opts.body });
    return { status: 200, body: JSON.stringify({ configs: { "qodercli-feature-gates": {} } }) };
  };
  const gates = await fetchFeatureGates(SESS, httpsRequest);
  assert.deepEqual(gates, {});
  assert.equal(calls[0].url, QCS_RESOLVE_URL);
  assert.match(calls[0].url, /openapi\.qoder\.com\.cn\/api\/v1\/qcs\/config\/resolve/);
  assert.equal(calls[0].headers.authorization, "Bearer jt-x");
  assert.deepEqual(JSON.parse(calls[0].body).namespaces, ["qodercli-feature-gates"]);
});

test("fetchCampaigns normalizes the payload", async () => {
  const httpsRequest = async (m, url) => {
    assert.equal(url, CAMPAIGNS_URL);
    return {
      status: 200,
      body: JSON.stringify({ showCampaign: false, claimable: false, campaignUrl: "", campaigns: [] }),
    };
  };
  const cs = await fetchCampaigns(SESS, httpsRequest);
  assert.deepEqual(cs, { showCampaign: false, claimable: false, campaignUrl: "", count: 0 });
});

test("runClaim executes detail + interaction endpoints with query.activityId", async () => {
  const calls = [];
  const httpsRequest = async (method, url, opts) => {
    calls.push({ method, url, opts });
    if (url.includes("/claim/detail")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { activityId: "act-1", canClaim: true },
            { activityId: "act-2", canClaim: true },
            { activityId: "act-3", canClaim: false },
          ],
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ code: "ok" }) };
  };
  const def = {
    name: "claim",
    detail: [{ domain: "openapi", path: "/sash/api/v1/me/claim/detail", method: "GET" }],
    interaction: [
      {
        domain: "openapi",
        path: "/sash/api/v1/me/claim/redeem",
        method: "POST",
        body: {},
      },
    ],
  };
  const result = await runClaim(def, SESS, { httpsRequest, sessionId: "sess-1" });
  assert.deepEqual(result.claimed, ["act-1", "act-2"]);
  assert.equal(result.ok, true);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /activityId=act-1/);
  assert.match(posts[1].url, /activityId=act-2/);
  assert.match(posts[0].url, /^https:\/\/openapi\.qoder\.com\.cn\//);
  assert.equal(posts[0].opts.headers.authorization, "Bearer jt-x");
});

test("runClaim reports per-activity errors instead of hiding them", async () => {
  const httpsRequest = async (method, url) => {
    if (url.includes("/detail")) {
      return { status: 200, body: JSON.stringify({ data: [{ activityId: "a1", canClaim: true }] }) };
    }
    return { status: 500, body: "boom" };
  };
  const def = {
    name: "claim",
    detail: [{ domain: "openapi", path: "/x/detail", method: "GET" }],
    interaction: [{ domain: "openapi", path: "/x/redeem", method: "POST", body: {} }],
  };
  const result = await runClaim(def, SESS, { httpsRequest });
  assert.equal(result.ok, false);
  assert.equal(result.claimed.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /a1: HTTP 500/);
});

test("runClaim notes when nothing is claimable", async () => {
  const httpsRequest = async () => ({
    status: 200,
    body: JSON.stringify({ data: [{ activityId: "a", canClaim: false }] }),
  });
  const def = {
    name: "claim",
    detail: [{ domain: "openapi", path: "/x/detail", method: "GET" }],
    interaction: [{ domain: "openapi", path: "/x/redeem", method: "POST", body: {} }],
  };
  const result = await runClaim(def, SESS, { httpsRequest });
  assert.equal(result.note, "nothing_claimable");
  assert.deepEqual(result.claimed, []);
});

test("claimStatus reports not-offered when gates are empty", async () => {
  const httpsRequest = async (method, url) => {
    if (url.includes("/qcs/config/resolve")) {
      return { status: 200, body: JSON.stringify({ configs: { "qodercli-feature-gates": {} } }) };
    }
    return {
      status: 200,
      body: JSON.stringify({ showCampaign: false, claimable: false, campaigns: [] }),
    };
  };
  const status = await claimStatus(SESS, httpsRequest);
  assert.equal(status.offered, false);
  assert.equal(status.def, null);
  assert.equal(status.campaigns.claimable, false);
});
