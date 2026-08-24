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

const PROFILE_PRINT_REASONING_EFFORTS = new Set([
  "none", "low", "medium", "high", "xhigh", "max"
]);

function createRadarConfig(env = process.env) {
  const instagramVerificationSecret = String(
    env.RADAR_INSTAGRAM_VERIFICATION_SECRET || ""
  ).trim() || null;
  const openAiApiKey = String(env.OPENAI_API_KEY || "").trim() || null;
  const profilePrintSecuritySecret = String(
    env.RADAR_PROFILE_PRINT_SECURITY_SECRET || ""
  ).trim() || null;
  const profilePrintOpenAiModel = String(
    env.RADAR_PROFILE_PRINT_OPENAI_MODEL || ""
  ).trim() || null;
  const requestedReasoningEffort = String(
    env.RADAR_PROFILE_PRINT_REASONING_EFFORT || "xhigh"
  ).trim().toLowerCase();
  const profilePrintReasoningEffort = PROFILE_PRINT_REASONING_EFFORTS.has(
    requestedReasoningEffort
  ) ? requestedReasoningEffort : null;
  const config = {
    enabled: parseBoolean(env.RADAR_AMISTOSOS_ENABLED, false),
    profilePrintImportEnabled: parseBoolean(
      env.RADAR_PROFILE_PRINT_IMPORT_ENABLED,
      false
    ),
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
    profilePrintOpenAiModel,
    profilePrintReasoningEffort,
    profilePrintOpenAiConfigured: Boolean(
      openAiApiKey &&
      profilePrintOpenAiModel &&
      profilePrintReasoningEffort &&
      profilePrintSecuritySecret &&
      Buffer.byteLength(profilePrintSecuritySecret, "utf8") >= 32
    ),
    profilePrintMaxFileBytes: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_MAX_FILE_BYTES,
      8 * 1024 * 1024,
      20 * 1024 * 1024
    ),
    profilePrintMaxWidth: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_MAX_WIDTH,
      6_000,
      12_000
    ),
    profilePrintMaxHeight: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_MAX_HEIGHT,
      6_000,
      12_000
    ),
    profilePrintMaxPixels: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_MAX_PIXELS,
      20_000_000,
      80_000_000
    ),
    profilePrintOpenAiTimeoutMs: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_OPENAI_TIMEOUT_MS,
      45_000,
      120_000
    ),
    profilePrintOpenAiMaxOutputTokens: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_OPENAI_MAX_OUTPUT_TOKENS,
      1_800,
      8_000
    ),
    profilePrintDraftTtlMinutes: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_DRAFT_TTL_MINUTES,
      120,
      24 * 60
    ),
    profilePrintCleanupIntervalMs: Math.max(
      boundedPositiveInteger(
        env.RADAR_PROFILE_PRINT_CLEANUP_INTERVAL_MS,
        15 * 60 * 1000,
        24 * 60 * 60 * 1000
      ),
      60 * 1000
    ),
    profilePrintRateWindowSeconds: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_RATE_WINDOW_SECONDS,
      60 * 60,
      24 * 60 * 60
    ),
    profilePrintAccountLimit: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_ACCOUNT_LIMIT,
      5,
      100
    ),
    profilePrintTeamLimit: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_TEAM_LIMIT,
      5,
      100
    ),
    profilePrintIpLimit: boundedPositiveInteger(
      env.RADAR_PROFILE_PRINT_IP_LIMIT,
      20,
      500
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
  Object.defineProperty(config, "openAiApiKey", {
    value: openAiApiKey,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "profilePrintSecuritySecret", {
    value: profilePrintSecuritySecret,
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
