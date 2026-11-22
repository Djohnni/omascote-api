"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createTesterBonusStore, TESTER_BONUS_ELIGIBLE_PRODUCTS } = require("./src/tester-bonus/tester-bonus.store");

const modulePath = path.join(__dirname, "src/tester-bonus/tester-bonus.store.js");
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-tester-bonus-"));
  t.after(() => {
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("omascote-tester-bonus-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { dataDir, store: createTesterBonusStore({ dataDir, ...options }) };
}
function input(index, extra = {}) {
  return { customerKey: "profile:tester-1", orderId: `ORDER-${index}`, requestId: `request-${index}`, payloadHash: hash(index), category: "mascote_uniforme", isVideo: false, ...extra };
}
function identity(usage, customerKey = "profile:tester-1") {
  return { customerKey, orderId: usage.orderId, usageId: usage.usageId };
}
function child(script, args = []) {
  return new Promise((resolve, reject) => {
    const process = spawn(global.process.execPath, ["-e", script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    process.stdout.on("data", value => { stdout += value; });
    process.stderr.on("data", value => { stderr += value; });
    process.on("error", reject);
    process.on("close", code => code === 0 ? resolve(stdout.trim() ? JSON.parse(stdout) : null) : reject(new Error(`child failed ${code}: ${stderr}`)));
  });
}

test("fixed grant survives restart and repeated approvals never restore spent images", async t => {
  const { dataDir, store } = fixture(t);
  assert.equal(store.hasGrant("profile:tester-1"), false);
  const first = await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  assert.equal(first.replayed, false);
  assert.equal(first.summary.remaining, 5);
  const usage = await store.reserve(input(1));
  await store.consume(identity(usage));
  const restarted = createTesterBonusStore({ dataDir });
  const approvedAgain = await restarted.grant({ customerKey: "profile:tester-1", actor: "admin", campaignId: "different-campaign" });
  assert.equal(approvedAgain.replayed, true);
  assert.equal(approvedAgain.grantId, first.grantId);
  assert.equal(approvedAgain.campaignId, first.campaignId);
  assert.equal(restarted.getSummary("profile:tester-1").remaining, 4);
  assert.equal(restarted.getSummary("profile:tester-1").consumed, 1);
  assert.equal(fs.existsSync(`${store.filePath}.lock`), false);
});

test("reservations count immediately and six simultaneous orders reserve exactly five", async t => {
  const { store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.reserve(input(i))));
  assert.equal(results.filter(value => value.used).length, 5);
  assert.equal(results.filter(value => value.reason === "exhausted").length, 1);
  assert.deepEqual(Object.fromEntries(["used", "reserved", "remaining"].map(key => [key, store.getSummary("profile:tester-1")[key]])), { used: 0, reserved: 5, remaining: 0 });
});

test("video, unknown delivery, paid addon and unknown product never use quota", async t => {
  const { store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  for (const [index, extra, reason] of [
    [1, { isVideo: true }, "video_not_eligible"],
    [2, { isVideo: undefined }, "video_not_eligible"],
    [3, { isVideo: "false" }, "video_not_eligible"],
    [4, { hasPaidAddon: true }, "addon_not_eligible"],
    [5, { category: "unlisted-product" }, "product_not_eligible"]
  ]) {
    const result = await store.reserve(input(index, extra));
    assert.equal(result.used, false);
    assert.equal(result.reason, reason);
  }
  assert.equal(store.getSummary("profile:tester-1").remaining, 5);
  assert.ok(TESTER_BONUS_ELIGIBLE_PRODUCTS.includes("mascote_uniforme"));
  assert.ok(TESTER_BONUS_ELIGIBLE_PRODUCTS.includes("escudo3d"));
});

test("replay recovers the original missing-draft order without reserving another image", async t => {
  const { dataDir, store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  const first = await store.reserve(input(1));
  const restarted = createTesterBonusStore({ dataDir });
  const replay = await restarted.reserve(input(1, { orderId: "A-NEW-DRAFT-ID" }));
  assert.equal(replay.used, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.orderId, first.orderId);
  assert.equal(replay.usageId, first.usageId);
  assert.equal(restarted.getSummary("profile:tester-1").remaining, 4);
  assert.equal(restarted.authorize(identity(replay)).authorized, true);
});

test("same request with changed payload or delivery and same order with new request conflict", async t => {
  const { store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  await store.reserve(input(1));
  for (const change of [{ payloadHash: hash("changed") }, { category: "escudo3d" }, { isVideo: true }, { hasPaidAddon: true }, { requestId: "request-2" }]) {
    await assert.rejects(store.reserve(input(1, change)), error => error.status === 409 && error.code === "TESTER_BONUS_IDEMPOTENCY_CONFLICT");
  }
  assert.equal(store.getSummary("profile:tester-1").remaining, 4);
});

test("consume, authorization and technical release are scoped and idempotent", async t => {
  const { store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  const usage = await store.reserve(input(1));
  assert.equal(store.authorize(identity(usage)).ok, true);
  assert.equal(store.authorize(identity(usage, "profile:other")).ok, false);
  assert.equal((await store.consume(identity(usage))).replayed, false);
  assert.equal((await store.consume(identity(usage))).replayed, true);
  assert.equal(store.authorize(identity(usage)).state, "consumed");
  assert.equal((await store.release({ ...identity(usage), reason: "confirmed_pipeline_failure" })).released, true);
  assert.equal((await store.release({ ...identity(usage), reason: "confirmed_pipeline_failure" })).released, false);
  assert.equal(store.getSummary("profile:tester-1").remaining, 5);
  assert.equal(store.authorize(identity(usage)).authorized, false);
  assert.equal((await store.consume(identity(usage))).consumed, false);
  const replay = await store.reserve(input(1));
  assert.equal(replay.used, false);
  assert.equal(replay.reason, "released");
  assert.equal(store.getSummary("profile:tester-1").remaining, 5);
});

test("other customers cannot reuse order identities and each customer has an isolated grant", async t => {
  const { store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  await store.grant({ customerKey: "profile:other", actor: "admin" });
  const original = await store.reserve(input(1));
  await assert.rejects(store.reserve(input(1, { customerKey: "profile:other" })), error => error.status === 409);
  assert.equal(store.getSummary("profile:other").remaining, 5);
  assert.equal((await store.release({ ...identity(original, "profile:other"), reason: "fake" })).released, false);
  assert.equal(store.getSummary("profile:tester-1").remaining, 4);
});

test("corrupt or inconsistent ledger fails closed without overwriting the evidence", async t => {
  const { store } = fixture(t);
  await store.grant({ customerKey: "profile:tester-1", actor: "admin" });
  fs.writeFileSync(store.filePath, "{broken");
  assert.throws(() => store.getSummary("profile:tester-1"), error => error.status === 503);
  assert.throws(() => store.authorize({ customerKey: "profile:tester-1", orderId: "x", usageId: "x" }), error => error.status === 503);
  await assert.rejects(store.grant({ customerKey: "profile:tester-1", actor: "admin" }), error => error.status === 503);
  assert.equal(fs.readFileSync(store.filePath, "utf8"), "{broken");
  assert.equal(fs.existsSync(`${store.filePath}.lock`), false);
});

test("filesystem lock protects quota between independent API processes", async t => {
  const { dataDir, store } = fixture(t);
  const script = `
    const {createTesterBonusStore}=require(process.argv[1]);
    const crypto=require('node:crypto');
    (async()=>{const s=createTesterBonusStore({dataDir:process.argv[2],lockTimeoutMs:10000});
    await s.grant({customerKey:'profile:tester-1',actor:'admin'});
    const i=process.argv[3];const result=await s.reserve({customerKey:'profile:tester-1',orderId:'CHILD-'+i,requestId:'child-request-'+i,payloadHash:crypto.createHash('sha256').update(i).digest('hex'),category:'mascote_uniforme',isVideo:false});
    process.stdout.write(JSON.stringify(result));})().catch(e=>{console.error(e);process.exitCode=1});
  `;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => child(script, [modulePath, dataDir, String(i)])));
  assert.equal(results.filter(value => value.used).length, 5);
  assert.equal(results.filter(value => value.reason === "exhausted").length, 3);
  assert.equal(store.getSummary("profile:tester-1").remaining, 0);
  assert.equal(store.getSummary("profile:tester-1").reserved, 5);
  assert.equal(fs.existsSync(`${store.filePath}.lock`), false);
});

test("lock from a demonstrably dead local process is recovered without a time-based steal", async t => {
  const { dataDir, store } = fixture(t);
  const script = `const fs=require('node:fs'),os=require('node:os');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,hostname:os.hostname(),token:'dead-owner'}),{flag:'wx'});process.stdout.write('{}');`;
  await child(script, [`${store.filePath}.lock`]);
  const recovered = await createTesterBonusStore({ dataDir }).grant({ customerKey: "profile:tester-1", actor: "admin" });
  assert.equal(recovered.summary.remaining, 5);
  assert.equal(fs.existsSync(`${store.filePath}.lock`), false);
});

test("a live holder or malformed lock blocks writes instead of being stolen", async t => {
  const { dataDir, store } = fixture(t, { lockTimeoutMs: 60, retryDelayMs: 5 });
  const lock = `${store.filePath}.lock`;
  for (const contents of [JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "live-owner" }), "not-json"]) {
    fs.writeFileSync(lock, contents);
    await assert.rejects(store.grant({ customerKey: "profile:tester-1", actor: "admin" }), error => error.status === 503 && error.code === "TESTER_BONUS_STORE_BUSY");
    assert.equal(fs.readFileSync(lock, "utf8"), contents);
  }
  assert.equal(fs.existsSync(path.join(dataDir, "tester-bonus.json")), false);
});
