"use strict";

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  return ["1", "true", "on", "yes"].includes(String(value).trim().toLowerCase());
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function createRadarConfig(env = process.env) {
  return Object.freeze({
    enabled: parseBoolean(env.RADAR_AMISTOSOS_ENABLED, false),
    pilotFree: parseBoolean(env.RADAR_AMISTOSOS_PILOT_FREE, true),
    publicRatingMinimumMatches:
      parseOptionalPositiveInteger(env.RADAR_PUBLIC_RATING_MIN_MATCHES) || 3,
    pilotCityIbgeCode: String(env.RADAR_PILOT_CITY_IBGE_CODE || "").trim() || null,
    moderationSlaHours: parseOptionalPositiveInteger(env.RADAR_MODERATION_SLA_HOURS),
    databaseUrl: String(env.DATABASE_URL || "").trim() || null,
    databaseSsl: parseBoolean(env.DATABASE_SSL, false),
    databaseSslRejectUnauthorized:
      parseBoolean(env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
    databaseConnectionTimeoutMs:
      parseOptionalPositiveInteger(env.DATABASE_CONNECTION_TIMEOUT_MS) || 5_000
  });
}

module.exports = {
  createRadarConfig,
  parseBoolean,
  parseOptionalPositiveInteger
};
