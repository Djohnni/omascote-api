"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");

function normalizeWhatsapp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  let international = digits;
  if (!raw.startsWith("+") && digits.length >= 10 && digits.length <= 11) {
    international = `55${digits}`;
  }
  if (!/^[1-9]\d{7,14}$/.test(international)) {
    throw new RadarIdentityError("VALIDATION_ERROR", 400, "whatsapp: numero invalido");
  }
  return `+${international}`;
}

function parseKeyRing(value) {
  const keys = new Map();
  for (const entry of String(value || "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const version = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (!/^v[1-9]\d{0,3}$/.test(version)) continue;
    try {
      const key = Buffer.from(encoded, "base64");
      if (key.length === 32) keys.set(version, key);
    } catch {}
  }
  return keys;
}

function requireWhatsappConfiguration(config) {
  const keys = parseKeyRing(config?.whatsappEncryptionKeyRing);
  const activeVersion = String(config?.whatsappEncryptionActiveVersion || "");
  if (!config?.whatsappConfigured || !keys.has(activeVersion) || !config.whatsappRateLimitSecret) {
    throw new RadarIdentityError(
      "RADAR_WHATSAPP_NOT_CONFIGURED",
      503,
      "Contato temporariamente indisponivel."
    );
  }
  return Object.freeze({ keys, activeVersion });
}

function encryptWhatsapp(number, config) {
  if (!number) return Object.freeze({ ciphertext: null, keyVersion: null });
  const { keys, activeVersion } = requireWhatsappConfiguration(config);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.get(activeVersion), iv);
  cipher.setAAD(Buffer.from(`radar-whatsapp:${activeVersion}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(number, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    ciphertext: Buffer.concat([iv, tag, encrypted]).toString("base64"),
    keyVersion: activeVersion
  });
}

function decryptWhatsapp(ciphertext, keyVersion, config) {
  const { keys } = requireWhatsappConfiguration(config);
  const key = keys.get(String(keyVersion || ""));
  if (!key) throw new RadarIdentityError("RADAR_WHATSAPP_KEY_UNAVAILABLE", 503, "Contato temporariamente indisponivel.");
  try {
    const packed = Buffer.from(String(ciphertext || ""), "base64");
    if (packed.length < 29) throw new Error("invalid payload");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`radar-whatsapp:${keyVersion}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new RadarIdentityError("RADAR_WHATSAPP_DECRYPT_FAILED", 503, "Contato temporariamente indisponivel.");
  }
}

function whatsappScopeHash(secret, scope, value) {
  return crypto.createHmac("sha256", secret).update(`radar-whatsapp-${scope}-v1:${value}`).digest("hex");
}

module.exports = {
  normalizeWhatsapp,
  parseKeyRing,
  requireWhatsappConfiguration,
  encryptWhatsapp,
  decryptWhatsapp,
  whatsappScopeHash
};
