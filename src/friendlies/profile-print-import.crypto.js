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

function requireProfilePrintConfiguration(config) {
  if (
    config?.profilePrintOpenAiConfigured !== true ||
    !config.openAiApiKey ||
    !config.profilePrintOpenAiModel ||
    !config.profilePrintSecuritySecret ||
    !config.profilePrintSafetyIdentifierSecret
  ) {
    throw new RadarIdentityError(
      "PROFILE_PRINT_IMPORT_NOT_CONFIGURED",
      503,
      "Importacao por print temporariamente indisponivel."
    );
  }
  return Object.freeze({
    apiKey: config.openAiApiKey,
    model: config.profilePrintOpenAiModel,
    securitySecret: config.profilePrintSecuritySecret,
    safetyIdentifierSecret: config.profilePrintSafetyIdentifierSecret
  });
}

function hmac(secret, purpose, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}

function importPayloadHash(secret, value) {
  return hmac(
    secret,
    "profile-print-payload-v1",
    JSON.stringify(stableValue(value))
  );
}

function importScopeHash(secret, scope, value) {
  return hmac(secret, `profile-print-rate-${scope}-v1`, String(value || ""));
}

function profilePrintSafetyIdentifier(secret, accountReference) {
  const reference = String(accountReference || "").trim();
  if (!secret || !reference) {
    throw new RadarIdentityError(
      "PROFILE_PRINT_IMPORT_NOT_CONFIGURED",
      503,
      "Importacao por print temporariamente indisponivel."
    );
  }
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`profile-print-safety-identifier-v1:${reference}`)
    .digest("base64url");
  return `rpp_${digest}`;
}

module.exports = {
  requireProfilePrintConfiguration,
  importPayloadHash,
  importScopeHash,
  profilePrintSafetyIdentifier
};
