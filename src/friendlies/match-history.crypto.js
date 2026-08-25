"use strict";

const crypto = require("node:crypto");
const { historyError } = require("./match-history.schemas");

function hmac(secret, purpose, value) {
  return crypto.createHmac("sha256", secret).update(`${purpose}:${value}`).digest("hex");
}

function safeHexEqual(first, second) {
  if (!/^[0-9a-f]{64}$/.test(String(first || "")) || !/^[0-9a-f]{64}$/.test(String(second || ""))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));
}

function requireHistorySecrets(config) {
  if (
    config?.matchHistoryConfigured !== true ||
    !config.matchHistoryCursorSecret ||
    !config.matchHistoryRateLimitSecret
  ) {
    throw historyError(
      "MATCH_HISTORY_NOT_CONFIGURED",
      503,
      "Historico temporariamente indisponivel."
    );
  }
  return Object.freeze({
    cursor: config.matchHistoryCursorSecret,
    rate: config.matchHistoryRateLimitSecret
  });
}

function fingerprint(filters) {
  return crypto.createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

function ownerScope(secret, teamId) {
  return hmac(secret, "match-history-owner-v1", String(teamId || ""));
}

function rateScopeHash(secret, type, value) {
  return hmac(secret, `match-history-rate-${type}-v1`, String(value || "unknown"));
}

function encodeHistoryCursor(secret, payload) {
  const data = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url");
  const signature = hmac(secret, "match-history-cursor-v1", data);
  return `${data}.${signature}`;
}

function invalidCursor(message = "Cursor de historico invalido.") {
  throw historyError("MATCH_HISTORY_CURSOR_INVALID", 400, message);
}

function decodeHistoryCursor(secret, cursor) {
  const raw = String(cursor || "").trim();
  if (!/^[A-Za-z0-9_-]{20,1700}\.[0-9a-f]{64}$/.test(raw)) invalidCursor();
  const [data, signature] = raw.split(".");
  const expected = hmac(secret, "match-history-cursor-v1", data);
  if (!safeHexEqual(signature, expected)) invalidCursor();
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (
      parsed?.v !== 1 ||
      !/^[0-9a-f]{64}$/.test(String(parsed.f || "")) ||
      !/^[0-9a-f]{64}$/.test(String(parsed.o || "")) ||
      !/^(?:all|opponent:[0-9a-f-]{36})$/.test(String(parsed.s || "")) ||
      Number.isNaN(new Date(parsed.i).getTime()) ||
      Number.isNaN(new Date(parsed.k?.scheduled_at).getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(parsed.k?.match_id || ""))
    ) invalidCursor();
    return Object.freeze({
      filtersFingerprint: parsed.f,
      ownerScope: parsed.o,
      scope: parsed.s,
      issuedAt: new Date(parsed.i),
      key: Object.freeze({
        scheduledAt: new Date(parsed.k.scheduled_at).toISOString(),
        matchId: String(parsed.k.match_id).toLowerCase()
      })
    });
  } catch (error) {
    if (error?.code === "MATCH_HISTORY_CURSOR_INVALID") throw error;
    invalidCursor();
  }
}

module.exports = {
  requireHistorySecrets,
  fingerprint,
  ownerScope,
  rateScopeHash,
  encodeHistoryCursor,
  decodeHistoryCursor,
  safeHexEqual
};
