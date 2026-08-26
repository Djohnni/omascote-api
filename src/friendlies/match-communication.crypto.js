"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");

function hmac(secret, purpose, value) {
  return crypto.createHmac("sha256", secret)
    .update(`radar-match-communication-v1\0${purpose}\0`)
    .update(String(value || ""))
    .digest("hex");
}

function accountPseudonym(config, accountReference) {
  return hmac(config.matchCommunicationSecuritySecret, "account", accountReference);
}

function scopeHash(config, scope, value) {
  return hmac(config.matchCommunicationSecuritySecret, `rate:${scope}`, value);
}

function payloadHash(config, value) {
  return hmac(config.matchCommunicationSecuritySecret, "payload", JSON.stringify(value));
}

function encodeCursor(config, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = hmac(config.matchCommunicationSecuritySecret, "cursor", payload);
  return `${payload}.${signature}`;
}

function decodeCursor(config, raw) {
  if (!raw) return null;
  const value = String(raw);
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !/^[0-9a-f]{64}$/.test(parts[1])) {
    throw new RadarIdentityError("MATCH_COMMUNICATION_CURSOR_INVALID", 400, "Pagina invalida.");
  }
  const expected = hmac(config.matchCommunicationSecuritySecret, "cursor", parts[0]);
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(parts[1], "hex");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new RadarIdentityError("MATCH_COMMUNICATION_CURSOR_INVALID", 400, "Pagina invalida.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.created_at || !Number.isSafeInteger(Number(parsed.sequence)) || Number(parsed.sequence) < 1) throw new Error("invalid");
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error("invalid");
    return Object.freeze({
      createdAt,
      sequence: Number(parsed.sequence)
    });
  } catch {
    throw new RadarIdentityError("MATCH_COMMUNICATION_CURSOR_INVALID", 400, "Pagina invalida.");
  }
}

module.exports = {
  accountPseudonym,
  scopeHash,
  payloadHash,
  encodeCursor,
  decodeCursor
};
