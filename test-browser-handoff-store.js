const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BrowserHandoffStore,
  BrowserHandoffStoreError,
  clampTtlMs,
  hashToken
} = require("./src/auth/browser-handoff-store");

function tempStorePath(t, name = "auth_browser_handoffs.json") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-handoff-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function newStore(filePath, options = {}) {
  return new BrowserHandoffStore({
    filePath,
    identifierSecret: "handoff-store-test-secret",
    ...options
  });
}

function issue(store, payload, sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000) {
  return store.issue({ ...payload, sessionExpiresAt });
}

test("TTL is clamped between 60 and 300 seconds", () => {
  assert.equal(clampTtlMs(1), 60_000);
  assert.equal(clampTtlMs(180_000), 180_000);
  assert.equal(clampTtlMs(999_999), 300_000);
  assert.equal(clampTtlMs("invalid"), 180_000);
});

test("persists only the token hash and survives a store restart", t => {
  const filePath = tempStorePath(t);
  const store = newStore(filePath);
  const issued = issue(store, { userId: "auto_cliente_1", ipAddress: "203.0.113.10" });

  assert.equal(issued.ok, true);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);

  const rawFile = fs.readFileSync(filePath, "utf8");
  const state = JSON.parse(rawFile);
  assert.equal(rawFile.includes(issued.token), false);
  assert.ok(state.active[hashToken(issued.token)]);

  const restarted = newStore(filePath);
  const redeemed = restarted.redeem(issued.token, { ipAddress: "203.0.113.10" });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.record.user_id, "auto_cliente_1");

  const replay = restarted.redeem(issued.token, { ipAddress: "203.0.113.10" });
  assert.deepEqual(replay.ok, false);
  assert.equal(replay.reason, "used");
});

test("malformed code neither creates nor changes the persistent store", t => {
  const filePath = tempStorePath(t);
  const store = newStore(filePath);

  assert.deepEqual(store.redeem("invalido"), { ok: false, reason: "invalid" });
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);

  issue(store, { userId: "auto_cliente_2", ipAddress: "203.0.113.11" });
  const before = fs.readFileSync(filePath, "utf8");
  assert.deepEqual(store.redeem("curto"), { ok: false, reason: "invalid" });
  const after = fs.readFileSync(filePath, "utf8");
  assert.equal(after, before);
});

test("expires a handoff using the server clock", t => {
  const filePath = tempStorePath(t);
  let now = Date.now();
  const store = newStore(filePath, { now: () => now, ttlMs: 60_000 });
  const issued = issue(store, { userId: "auto_cliente_3", ipAddress: "203.0.113.12" });

  now += 60_001;
  const expired = store.redeem(issued.token, { ipAddress: "203.0.113.12" });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});

test("never lets the handoff outlive the source JWT session", t => {
  const filePath = tempStorePath(t);
  let now = Date.now();
  const store = newStore(filePath, { now: () => now, ttlMs: 180_000 });
  const sourceSessionExpiry = now + 75_000;
  const issued = issue(
    store,
    { userId: "auto_cliente_sessao", ipAddress: "203.0.113.19" },
    sourceSessionExpiry
  );

  assert.equal(issued.expiresAt, sourceSessionExpiry);
  assert.equal(issued.expiresInMs, 75_000);

  now = sourceSessionExpiry + 1;
  const expired = store.redeem(issued.token, { ipAddress: "203.0.113.19" });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");
});

test("keeps only the newest active handoff per user", t => {
  const filePath = tempStorePath(t);
  const store = newStore(filePath);
  const first = issue(store, { userId: "auto_cliente_4", ipAddress: "203.0.113.13" });
  const second = issue(store, { userId: "auto_cliente_4", ipAddress: "203.0.113.13" });

  const superseded = store.redeem(first.token, { ipAddress: "203.0.113.13" });
  assert.equal(superseded.ok, false);
  assert.equal(superseded.reason, "superseded");
  assert.equal(store.redeem(second.token, { ipAddress: "203.0.113.13" }).ok, true);
});

test("allows exactly one redemption across independent store instances", async t => {
  const filePath = tempStorePath(t);
  const issuer = newStore(filePath);
  const issued = issue(issuer, { userId: "auto_cliente_5", ipAddress: "203.0.113.14" });
  const first = newStore(filePath);
  const second = newStore(filePath);

  const results = await Promise.all([
    Promise.resolve().then(() => first.redeem(issued.token, { ipAddress: "203.0.113.14" })),
    Promise.resolve().then(() => second.redeem(issued.token, { ipAddress: "203.0.113.14" }))
  ]);

  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok && result.reason === "used").length, 1);
});

test("enforces persistent user and IP rate limits", t => {
  const userFilePath = tempStorePath(t, "user-rate.json");
  const userStore = newStore(userFilePath, {
    issueUserLimit: 1,
    issueIpLimit: 10,
    redeemIpLimit: 10
  });
  issue(userStore, { userId: "auto_cliente_6", ipAddress: "203.0.113.15" });
  const userLimited = issue(userStore, {
    userId: "auto_cliente_6",
    ipAddress: "203.0.113.15"
  });

  assert.equal(userLimited.ok, false);
  assert.equal(userLimited.reason, "rate_limited");
  assert.ok(userLimited.retryAfterMs > 0);

  const ipFilePath = tempStorePath(t, "ip-rate.json");
  const ipStore = newStore(ipFilePath, {
    issueUserLimit: 10,
    issueIpLimit: 1,
    redeemIpLimit: 10
  });
  issue(ipStore, { userId: "auto_cliente_7", ipAddress: "203.0.113.16" });
  const ipLimited = issue(ipStore, {
    userId: "auto_cliente_8",
    ipAddress: "203.0.113.16"
  });

  assert.equal(ipLimited.ok, false);
  assert.equal(ipLimited.reason, "rate_limited");

  const redeemFilePath = tempStorePath(t, "redeem-rate.json");
  const redeemStore = newStore(redeemFilePath, {
    issueUserLimit: 10,
    issueIpLimit: 10,
    redeemIpLimit: 1
  });
  const issued = issue(redeemStore, {
    userId: "auto_cliente_9",
    ipAddress: "203.0.113.17"
  });

  assert.equal(redeemStore.redeem(issued.token, { ipAddress: "203.0.113.17" }).ok, true);
  const redeemLimited = redeemStore.redeem("A".repeat(43), {
    ipAddress: "203.0.113.17"
  });
  assert.equal(redeemLimited.ok, false);
  assert.equal(redeemLimited.reason, "rate_limited");
});

test("fails closed when the persistent state is corrupt", t => {
  const filePath = tempStorePath(t);
  fs.writeFileSync(filePath, "{invalido", "utf8");
  const store = newStore(filePath);

  assert.throws(
    () => issue(store, { userId: "auto_cliente_10", ipAddress: "203.0.113.18" }),
    error => error instanceof BrowserHandoffStoreError && error.code === "storage_unavailable"
  );
});
