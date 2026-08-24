"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function hmac(secret, purpose, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}

function safeHexEqual(first, second) {
  if (!/^[0-9a-f]{64}$/.test(String(first || "")) || !/^[0-9a-f]{64}$/.test(String(second || ""))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));
}

function requireSearchSecrets(config) {
  if (
    config?.searchConfigured !== true ||
    !config.searchCursorSecret ||
    !config.searchRateLimitSecret
  ) {
    throw new RadarIdentityError(
      "FRIENDLY_SEARCH_NOT_CONFIGURED",
      503,
      "Busca de times temporariamente indisponivel."
    );
  }
  return Object.freeze({
    cursor: config.searchCursorSecret,
    rate: config.searchRateLimitSecret
  });
}

function filtersFingerprint(filters) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(filters)))
    .digest("hex");
}

function originScope(secret, origin) {
  return hmac(
    secret,
    "friendly-search-origin-v1",
    `${origin?.id || ""}:${origin?.version || 0}`
  );
}

function rateScopeHash(secret, type, value) {
  return hmac(secret, `friendly-search-rate-${type}-v1`, String(value || "unknown"));
}

function encodeSearchCursor(secret, payload) {
  const data = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url");
  const signature = hmac(secret, "friendly-search-cursor-v1", data);
  return `${data}.${signature}`;
}

function invalidCursor(code = "FRIENDLY_SEARCH_CURSOR_INVALID", message = "Cursor de busca invalido.") {
  throw new RadarIdentityError(code, 400, message);
}

function decodeSearchCursor(secret, cursor) {
  const raw = String(cursor || "").trim();
  if (!/^[A-Za-z0-9_-]{20,1800}\.[0-9a-f]{64}$/.test(raw)) invalidCursor();
  const [data, signature] = raw.split(".");
  const expected = hmac(secret, "friendly-search-cursor-v1", data);
  if (!safeHexEqual(signature, expected)) invalidCursor();
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    const key = parsed?.k;
    if (
      parsed?.v !== 1 ||
      !/^[0-9a-f]{64}$/.test(String(parsed.f || "")) ||
      !/^[0-9a-f]{64}$/.test(String(parsed.o || "")) ||
      Number.isNaN(new Date(parsed.s).getTime()) ||
      !key ||
      !Number.isInteger(key.score) ||
      typeof key.distance !== "number" || !Number.isFinite(key.distance) || key.distance < 0 ||
      Number.isNaN(new Date(key.starts_at).getTime()) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(key.slug || ""))
    ) invalidCursor();
    return Object.freeze({
      filtersFingerprint: parsed.f,
      originScope: parsed.o,
      snapshot: new Date(parsed.s),
      key: Object.freeze({
        score: key.score,
        distance: key.distance,
        startsAt: new Date(key.starts_at).toISOString(),
        slug: key.slug
      })
    });
  } catch (error) {
    if (error instanceof RadarIdentityError) throw error;
    invalidCursor();
  }
}

module.exports = {
  requireSearchSecrets,
  filtersFingerprint,
  originScope,
  rateScopeHash,
  encodeSearchCursor,
  decodeSearchCursor,
  safeHexEqual
};
