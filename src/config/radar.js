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

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = parseOptionalPositiveInteger(value);
  if (!parsed) return fallback;
  return Math.min(parsed, maximum);
}

function createRadarConfig(env = process.env) {
  const instagramVerificationSecret = String(
    env.RADAR_INSTAGRAM_VERIFICATION_SECRET || ""
  ).trim() || null;
  const config = {
    enabled: parseBoolean(env.RADAR_AMISTOSOS_ENABLED, false),
    pilotFree: parseBoolean(env.RADAR_AMISTOSOS_PILOT_FREE, true),
    publicRatingMinimumMatches:
      parseOptionalPositiveInteger(env.RADAR_PUBLIC_RATING_MIN_MATCHES) || 3,
    pilotCityIbgeCode: String(env.RADAR_PILOT_CITY_IBGE_CODE || "").trim() || null,
    moderationSlaHours: parseOptionalPositiveInteger(env.RADAR_MODERATION_SLA_HOURS),
    instagramVerificationConfigured: Boolean(
      instagramVerificationSecret && Buffer.byteLength(instagramVerificationSecret, "utf8") >= 32
    ),
    instagramChallengeTtlMinutes: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_CHALLENGE_TTL_MINUTES,
      20,
      24 * 60
    ),
    instagramChallengeMaxAttempts: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_CHALLENGE_MAX_ATTEMPTS,
      5,
      20
    ),
    instagramRateWindowSeconds: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_RATE_WINDOW_SECONDS,
      60 * 60,
      24 * 60 * 60
    ),
    instagramInitiateAccountLimit: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_INITIATE_ACCOUNT_LIMIT,
      5,
      100
    ),
    instagramInitiateTeamLimit: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_INITIATE_TEAM_LIMIT,
      5,
      100
    ),
    instagramInitiateIpLimit: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_INITIATE_IP_LIMIT,
      20,
      500
    ),
    instagramConfirmAccountLimit: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_CONFIRM_ACCOUNT_LIMIT,
      20,
      500
    ),
    instagramConfirmTeamLimit: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_CONFIRM_TEAM_LIMIT,
      20,
      500
    ),
    instagramConfirmIpLimit: boundedPositiveInteger(
      env.RADAR_INSTAGRAM_CONFIRM_IP_LIMIT,
      60,
      1000
    ),
    instagramTrustedProxyHops: Math.min(
      Number.isInteger(Number(env.RADAR_TRUST_PROXY_HOPS))
        ? Math.max(Number(env.RADAR_TRUST_PROXY_HOPS), 0)
        : 0,
      5
    ),
    databaseUrl: String(env.DATABASE_URL || "").trim() || null,
    databaseSsl: parseBoolean(env.DATABASE_SSL, false),
    databaseSslRejectUnauthorized:
      parseBoolean(env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
    databaseConnectionTimeoutMs:
      parseOptionalPositiveInteger(env.DATABASE_CONNECTION_TIMEOUT_MS) || 5_000
  };
  Object.defineProperty(config, "instagramVerificationSecret", {
    value: instagramVerificationSecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(config);
}

module.exports = {
  createRadarConfig,
  parseBoolean,
  parseOptionalPositiveInteger,
  boundedPositiveInteger
};
