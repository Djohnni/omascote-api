"use strict";

const LEGACY_JWT_SECRET = "TROQUE_ISSO_AGORA";

function readJwtSecret(env = process.env) {
  const value = String(env.JWT_SECRET || "").trim();
  if (!value || value === LEGACY_JWT_SECRET || Buffer.byteLength(value, "utf8") < 24) {
    const error = new Error("JWT_SECRET must be configured with at least 24 bytes");
    error.code = "JWT_SECRET_CONFIGURATION_REQUIRED";
    throw error;
  }
  return value;
}

module.exports = { LEGACY_JWT_SECRET, readJwtSecret };
