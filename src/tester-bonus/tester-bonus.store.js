"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TESTER_BONUS_LIMIT = 5;
const DEFAULT_CAMPAIGN_ID = "playstore-testers-2026";
const TESTER_BONUS_ELIGIBLE_PRODUCTS = Object.freeze([
  "resultado", "escalacao", "contratacao", "proximo_jogo", "patrocinador",
  "escudo3d", "proximo_jogo_jogador", "resultado_jogo_jogador",
  "jogador_escudo", "mascote_uniforme"
]);
const eligibleProducts = new Set(TESTER_BONUS_ELIGIBLE_PRODUCTS);
const usageStates = new Set(["reserved", "consumed", "released"]);

class TesterBonusStoreError extends Error {
  constructor(code, status = 503, cause = null) {
    super(code);
    this.name = "TesterBonusStoreError";
    this.code = code;
    this.status = status;
    this.retryable = status === 503;
    if (cause) this.cause = cause;
  }
}

function requiredString(value, name, maximum = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum || /[\x00-\x1f\x7f]/.test(text)) {
    throw new TesterBonusStoreError(`TESTER_BONUS_INVALID_${name.toUpperCase()}`, 400);
  }
  return text;
}

function customerHash(customerKey) {
  return crypto.createHash("sha256").update(customerKey, "utf8").digest("hex");
}

function emptyState() {
  return { version: 1, grants: {}, usages: {} };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function validateState(state) {
  if (!isObject(state) || state.version !== 1 || !isObject(state.grants) || !isObject(state.usages)) {
    throw new Error("invalid_ledger_schema");
  }
  const requests = new Set();
  const orders = new Set();
  const activeCounts = new Map();
  for (const [key, grant] of Object.entries(state.grants)) {
    if (!isObject(grant) || typeof grant.customerKey !== "string" ||
        key !== customerHash(grant.customerKey) || typeof grant.id !== "string" ||
        !grant.id || grant.limit !== TESTER_BONUS_LIMIT || grant.active !== true ||
        typeof grant.campaignId !== "string" || !grant.campaignId ||
        typeof grant.actor !== "string" || !grant.actor || !validDate(grant.grantedAt)) {
      throw new Error("invalid_ledger_grant");
    }
  }
  for (const [id, usage] of Object.entries(state.usages)) {
    const grant = isObject(usage) && state.grants[customerHash(String(usage.customerKey || ""))];
    if (!grant || usage.id !== id || usage.grantId !== grant.id ||
        !usageStates.has(usage.state) || !eligibleProducts.has(usage.category) ||
        usage.isVideo !== false || usage.hasPaidAddon !== false ||
        typeof usage.orderId !== "string" || !usage.orderId ||
        typeof usage.requestId !== "string" || !usage.requestId ||
        !/^[0-9a-f]{64}$/.test(usage.payloadHash) || !validDate(usage.reservedAt) ||
        (usage.state === "consumed" && !validDate(usage.consumedAt)) ||
        (usage.state === "released" && (!validDate(usage.releasedAt) || !usage.releaseReason))) {
      throw new Error("invalid_ledger_usage");
    }
    const requestKey = `${customerHash(usage.customerKey)}:${usage.requestId}`;
    if (requests.has(requestKey) || orders.has(usage.orderId)) throw new Error("duplicate_ledger_usage");
    requests.add(requestKey);
    orders.add(usage.orderId);
    if (usage.state !== "released") activeCounts.set(grant.id, (activeCounts.get(grant.id) || 0) + 1);
  }
  for (const count of activeCounts.values()) if (count > TESTER_BONUS_LIMIT) throw new Error("ledger_quota_exceeded");
  return state;
}

/**
 * Persistent quota for ONE initial five-image grant per customer.
 * Writers use a filesystem-exclusive lock and atomic rename; reads never cache.
 * This requires all API processes to share the SAME persistent dataDir/filesystem.
 * A different campaign id does not reset an existing customer's grant.
 * release() is an internal trusted-caller operation: the caller must first prove
 * technical failure/cancellation without a valid delivered result.
 */
function createTesterBonusStore(options = {}) {
  if (!options.dataDir) throw new TesterBonusStoreError("TESTER_BONUS_DATA_DIR_REQUIRED", 400);
  const dataDir = path.resolve(String(options.dataDir));
  const filePath = path.join(dataDir, "tester-bonus.json");
  const lockPath = `${filePath}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  const lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? Math.max(50, options.lockTimeoutMs) : 5000;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(5, options.retryDelayMs) : 20;
  const timestamp = () => new Date().toISOString();

  function unavailable(error, code = "TESTER_BONUS_STORAGE_UNAVAILABLE") {
    return error instanceof TesterBonusStoreError ? error : new TesterBonusStoreError(code, 503, error);
  }

  function read() {
    try {
      let contents;
      try { contents = fs.readFileSync(filePath, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return emptyState(); throw error; }
      if (Buffer.byteLength(contents, "utf8") > 16 * 1024 * 1024) throw new Error("ledger_too_large");
      return validateState(JSON.parse(contents));
    } catch (error) { throw unavailable(error); }
  }

  function persist(state) {
    validateState(state);
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, filePath);
      // Persist the rename when supported by the host filesystem (Render/Linux).
      let directory = null;
      try { directory = fs.openSync(dataDir, "r"); fs.fsyncSync(directory); }
      catch (error) { if (!["EINVAL", "ENOTSUP", "EPERM", "EACCES", "EISDIR"].includes(error.code)) throw error; }
      finally { if (directory !== null) fs.closeSync(directory); }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  function processKnownDead(owner) {
    if (!owner || owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === "ESRCH"; }
  }

  // Never steal by elapsed time. Only recover a lock from a provably dead local
  // process, serializing recovery attempts with another exclusive filesystem lock.
  // Unknown/malformed/other-host locks fail closed and need operator inspection.
  function recoverDeadOwner() {
    let recoveryDescriptor = null;
    try {
      recoveryDescriptor = fs.openSync(recoveryPath, "wx", 0o600);
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (!processKnownDead(owner)) return;
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current.token === owner.token && processKnownDead(current)) fs.unlinkSync(lockPath);
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    } finally {
      if (recoveryDescriptor !== null) {
        fs.closeSync(recoveryDescriptor);
        try { fs.unlinkSync(recoveryPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }

  async function acquire() {
    fs.mkdirSync(dataDir, { recursive: true });
    const startedAt = Date.now();
    const token = crypto.randomBytes(18).toString("hex");
    while (true) {
      let descriptor = null;
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), createdAt: timestamp() }), "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        return token;
      } catch (error) {
        if (descriptor !== null) {
          try { fs.closeSync(descriptor); } catch {}
          // We created this lock but could not publish ownership. Do not leave
          // an empty lock permanently blocking a recoverable storage failure.
          try { fs.unlinkSync(lockPath); } catch {}
        }
        if (error.code !== "EEXIST") throw error;
        recoverDeadOwner();
        if (Date.now() - startedAt >= lockTimeoutMs) {
          throw new TesterBonusStoreError("TESTER_BONUS_STORE_BUSY", 503);
        }
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  async function mutate(operation) {
    let token;
    try {
      token = await acquire();
      const state = read();
      const result = operation(state);
      if (result.changed) persist(state);
      return result.value;
    } catch (error) { throw unavailable(error); }
    finally {
      if (token) {
        try {
          const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (owner.token !== token) throw new Error("lock_ownership_lost");
          fs.unlinkSync(lockPath);
        } catch (error) { throw unavailable(error); }
      }
    }
  }

  function summaryOf(state, customerKey) {
    const grant = state.grants[customerHash(customerKey)];
    if (!grant) return Object.freeze({ granted: false, active: false, limit: 0, used: 0, consumed: 0, reserved: 0, remaining: 0, available: 0, campaignId: null, grantId: null });
    const usages = Object.values(state.usages).filter(usage => usage.grantId === grant.id);
    const consumed = usages.filter(usage => usage.state === "consumed").length;
    const reserved = usages.filter(usage => usage.state === "reserved").length;
    const remaining = Math.max(0, grant.limit - consumed - reserved);
    return Object.freeze({ granted: true, active: true, limit: grant.limit, used: consumed, consumed, reserved, remaining, available: remaining, campaignId: grant.campaignId, grantId: grant.id });
  }

  function getSummary(customerKey) {
    return summaryOf(read(), requiredString(customerKey, "customer", 300));
  }

  function hasGrant(customerKey) { return getSummary(customerKey).granted; }

  async function grant({ customerKey, actor, campaignId = DEFAULT_CAMPAIGN_ID } = {}) {
    const customer = requiredString(customerKey, "customer", 300);
    const approvedBy = requiredString(actor, "actor", 300);
    const campaign = requiredString(campaignId, "campaign", 100);
    return mutate(state => {
      const key = customerHash(customer);
      const existing = state.grants[key];
      if (existing) return { changed: false, value: { granted: true, replayed: true, grantId: existing.id, campaignId: existing.campaignId, summary: summaryOf(state, customer) } };
      const added = { id: crypto.randomUUID(), customerKey: customer, campaignId: campaign, limit: TESTER_BONUS_LIMIT, active: true, actor: approvedBy, grantedAt: timestamp() };
      state.grants[key] = added;
      return { changed: true, value: { granted: true, replayed: false, grantId: added.id, campaignId: campaign, summary: summaryOf(state, customer) } };
    });
  }

  async function reserve({ customerKey, orderId, requestId, payloadHash, category, isVideo, hasPaidAddon = false } = {}) {
    const customer = requiredString(customerKey, "customer", 300);
    const order = requiredString(orderId, "order", 120);
    const request = requiredString(requestId, "request", 180);
    const product = requiredString(category, "category", 80).toLowerCase();
    const hash = requiredString(payloadHash, "payload_hash", 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new TesterBonusStoreError("TESTER_BONUS_INVALID_PAYLOAD_HASH", 400);
    return mutate(state => {
      const existing = Object.values(state.usages).find(usage =>
        usage.orderId === order || (usage.customerKey === customer && usage.requestId === request));
      if (existing) {
        if (existing.customerKey !== customer || existing.requestId !== request ||
            existing.payloadHash !== hash || existing.category !== product ||
            existing.isVideo !== isVideo || existing.hasPaidAddon !== hasPaidAddon) {
          throw new TesterBonusStoreError("TESTER_BONUS_IDEMPOTENCY_CONFLICT", 409);
        }
        return { changed: false, value: { used: existing.state !== "released", reason: existing.state === "released" ? "released" : undefined, usageId: existing.id, orderId: existing.orderId, replayed: true, state: existing.state, summary: summaryOf(state, customer) } };
      }
      const grant = state.grants[customerHash(customer)];
      if (!grant) return { changed: false, value: { used: false, reason: "no_grant" } };
      if (!eligibleProducts.has(product)) return { changed: false, value: { used: false, reason: "product_not_eligible" } };
      if (isVideo !== false) return { changed: false, value: { used: false, reason: "video_not_eligible" } };
      if (hasPaidAddon !== false) return { changed: false, value: { used: false, reason: "addon_not_eligible" } };
      if (summaryOf(state, customer).remaining <= 0) return { changed: false, value: { used: false, reason: "exhausted" } };
      const usage = { id: crypto.randomUUID(), grantId: grant.id, customerKey: customer, orderId: order, requestId: request, payloadHash: hash, category: product, isVideo: false, hasPaidAddon: false, state: "reserved", reservedAt: timestamp() };
      state.usages[usage.id] = usage;
      return { changed: true, value: { used: true, usageId: usage.id, orderId: order, replayed: false, state: usage.state, summary: summaryOf(state, customer) } };
    });
  }

  function findAuthorized(state, { customerKey, orderId, usageId } = {}) {
    const usage = typeof usageId === "string" ? state.usages[usageId] : null;
    if (!usage || usage.customerKey !== customerKey || usage.orderId !== orderId) {
      return { ok: false, authorized: false, reason: "usage_not_found" };
    }
    const grant = state.grants[customerHash(usage.customerKey)];
    if (!grant || grant.id !== usage.grantId || grant.active !== true || usage.state === "released") {
      return { ok: false, authorized: false, reason: usage.state === "released" ? "released" : "grant_inactive" };
    }
    return { ok: true, authorized: true, usageId: usage.id, orderId: usage.orderId, grantId: grant.id, state: usage.state };
  }

  function authorize(input) { return findAuthorized(read(), input); }

  async function consume(input = {}) {
    return mutate(state => {
      const authorization = findAuthorized(state, input);
      if (!authorization.ok) return { changed: false, value: { ...authorization, consumed: false } };
      const usage = state.usages[input.usageId];
      const replayed = usage.state === "consumed";
      if (!replayed) { usage.state = "consumed"; usage.consumedAt = timestamp(); }
      return { changed: !replayed, value: { ...authorization, state: "consumed", consumed: true, replayed, summary: summaryOf(state, usage.customerKey) } };
    });
  }

  async function release(input = {}) {
    const reason = requiredString(input.reason, "release_reason", 180);
    return mutate(state => {
      const usage = state.usages[input.usageId];
      if (!usage || usage.customerKey !== input.customerKey || usage.orderId !== input.orderId) {
        return { changed: false, value: { ok: false, released: false, reason: "usage_not_found" } };
      }
      if (usage.state === "released") return { changed: false, value: { ok: true, released: false, replayed: true, usageId: usage.id, orderId: usage.orderId, summary: summaryOf(state, usage.customerKey) } };
      usage.state = "released";
      usage.releasedAt = timestamp();
      usage.releaseReason = reason;
      return { changed: true, value: { ok: true, released: true, replayed: false, usageId: usage.id, orderId: usage.orderId, summary: summaryOf(state, usage.customerKey) } };
    });
  }

  // Recovery deliberately happens by replay, never by a reservation age/TTL.
  // The original orderId is returned and must be used when recreating a draft.
  // A trusted reconciler may release only after proving the order cannot still
  // be committed/processing; a missing file alone is not sufficient evidence.
  return Object.freeze({ filePath, getSummary, summary: getSummary, hasGrant, grant, reserve, authorize, consume, release });
}

module.exports = { createTesterBonusStore, TesterBonusStoreError, TESTER_BONUS_LIMIT, TESTER_BONUS_ELIGIBLE_PRODUCTS, DEFAULT_CAMPAIGN_ID };
