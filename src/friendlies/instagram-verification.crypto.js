"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function requireVerificationSecret(config) {
  if (
    config?.instagramVerificationConfigured !== true ||
    !config.instagramVerificationSecret
  ) {
    throw new RadarIdentityError(
      "INSTAGRAM_VERIFICATION_NOT_CONFIGURED",
      503,
      "Verificacao do Instagram temporariamente indisponivel."
    );
  }
  return config.instagramVerificationSecret;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function hmacHex(secret, purpose, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}

function challengeForPublicId(secret, publicId) {
  const bytes = crypto
    .createHmac("sha256", secret)
    .update(`instagram-challenge-v1:${publicId}`)
    .digest();
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return Object.freeze({
    code: `MCFC-${suffix.slice(0, 4)}-${suffix.slice(4)}`,
    segments: Object.freeze(["MCFC", suffix.slice(0, 4), suffix.slice(4)]),
    separator: "-"
  });
}

function challengeHash(secret, code) {
  return hmacHex(secret, "instagram-code-v1", String(code || "").trim().toUpperCase());
}

function payloadHash(secret, value) {
  return hmacHex(secret, "instagram-payload-v1", JSON.stringify(stableValue(value)));
}

function scopeHash(secret, scopeType, value) {
  return hmacHex(secret, `instagram-rate-${scopeType}-v1`, String(value || ""));
}

function hashesEqual(first, second) {
  if (!/^[0-9a-f]{64}$/.test(String(first || "")) || !/^[0-9a-f]{64}$/.test(String(second || ""))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));
}

module.exports = {
  requireVerificationSecret,
  challengeForPublicId,
  challengeHash,
  payloadHash,
  scopeHash,
  hashesEqual
};
