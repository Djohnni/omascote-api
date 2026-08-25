"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function loadClient(fetchImpl, traces = []) {
  global.window = {
    fetch: fetchImpl,
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    setTimeout,
    clearTimeout,
    RadarApi: null
  };
  delete require.cache[require.resolve("./radar-api.js")];
  require("./radar-api.js");
  return window.RadarApi.create({
    demoMode: false,
    baseUrl: "https://api.example.invalid",
    getAccessToken: () => "test-token-not-logged",
    fetchImpl,
    onTrace: item => traces.push(item)
  });
}

test("real client sends authentication, idempotency and optimistic version without tracing secrets", async () => {
  let captured;
  const traces = [];
  const client = loadClient(async (url, options) => {
    captured = { url: String(url), options };
    return response(200, { ok: true, profile: { version: 4 } }, { ETag: 'W/"4"', "Cache-Control": "private, no-store" });
  }, traces);
  const result = await client.updateRadarProfile({ city_name: "Joinville" }, 'W/"3"', "idem-local-1");
  assert.equal(captured.url, "https://api.example.invalid/me/time/radar");
  assert.equal(captured.options.headers.get("Authorization"), "Bearer test-token-not-logged");
  assert.equal(captured.options.headers.get("If-Match"), 'W/"3"');
  assert.equal(captured.options.headers.get("Idempotency-Key"), "idem-local-1");
  assert.equal(result.etag, 'W/"4"');
  assert.equal(JSON.stringify(traces).includes("test-token-not-logged"), false);
  assert.equal(JSON.stringify(traces).includes("Joinville"), false);
});

test("real client preserves pagination and maps session, conflict and API outage safely", async () => {
  const paths = [];
  const client = loadClient(async url => {
    paths.push(String(url));
    if (paths.length === 1) return response(401, { ok: false, code: "SESSION_INVALID" });
    if (paths.length === 2) return response(412, { ok: false, code: "VERSION_CONFLICT" });
    throw new Error("offline");
  });
  await assert.rejects(client.listNotifications("signed_cursor"), error => error.status === 401 && error.code === "SESSION_INVALID");
  await assert.rejects(client.getMatch("11111111-1111-4111-8111-111111111111"), error => error.status === 412 && error.code === "VERSION_CONFLICT");
  await assert.rejects(client.getOwnReputation(), error => error.status === 0 && error.code === "NETWORK_ERROR");
  assert.equal(paths[0].endsWith("/me/notificacoes?cursor=signed_cursor"), true);
});

test("demo remains network-blocked and separate from the real client", async () => {
  global.window = { crypto: { randomUUID: () => "unused" }, setTimeout, clearTimeout, fetch: async () => { throw new Error("must not run"); } };
  delete require.cache[require.resolve("./radar-api.js")];
  require("./radar-api.js");
  const demo = window.RadarApi.create({ demoMode: true });
  await assert.rejects(demo.getEligibility(), error => error.code === "DEMO_NETWORK_BLOCKED");
});
