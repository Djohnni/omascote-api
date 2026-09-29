const test = require("node:test");
const assert = require("node:assert/strict");
const { DownloadLinkStore } = require("./src/download/download-link");

test("link is opaque, scoped and repeatable for HEAD/Range until expiry", () => {
  let now = 100;
  const store = new DownloadLinkStore({ now: () => now });
  const issued = store.issue({ userId: "u1", resourceId: "p1", format: "video" });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresInMs, 300000);
  assert.equal(store.records.has(issued.token), false, "only hashes stored");
  const expected = { resourceId: "p1", format: "video" };
  for (let i = 0; i < 4; i++) assert.equal(store.resolve(issued.token, expected).userId, "u1");
  assert.equal(store.resolve(issued.token, { ...expected, resourceId: "p2" }), null);
  assert.equal(store.resolve(issued.token, { ...expected, format: "resultado" }), null);
  assert.equal(store.resolve(issued.token + "x", expected), null);
  assert.equal(store.resolve([issued.token], expected), null);
  now += 300000;
  assert.equal(store.resolve(issued.token, expected), null);
  assert.equal(store.records.size, 0);
});

test("store is bounded and expired entries are pruned on issue", () => {
  let now = 1;
  const store = new DownloadLinkStore({ now: () => now, maxEntries: 1 });
  const input = { userId: "u1", resourceId: "p1", format: "resultado" };
  store.issue(input);
  assert.throws(() => store.issue(input), /capacity/);
  now += 300000;
  assert.ok(store.issue(input).token);
  assert.throws(() => store.issue({ ...input, format: "zip" }), /invalid/);
});
