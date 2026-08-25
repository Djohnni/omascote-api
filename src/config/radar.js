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

function parsePilotAccountAllowlist(value) {
  const accounts = String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(item => /^[A-Za-z0-9._:-]{3,160}$/.test(item));
  return Object.freeze([...new Set(accounts)]);
}

const PROFILE_PRINT_REASONING_EFFORTS = new Set([
  "none", "low", "medium", "high", "xhigh", "max"
]);

function createRadarConfig(env = process.env) {
  const pilotAccountAllowlist = parsePilotAccountAllowlist(
    env.RADAR_PILOT_ACCOUNT_ALLOWLIST
  );
  const requestedEmbeddedPath = String(
    env.RADAR_DATABASE_EMBEDDED_PATH || ""
  ).trim() || null;
  const databaseEmbeddedPath = String(env.NODE_ENV || "").toLowerCase() === "production"
    ? null
    : requestedEmbeddedPath;
  const instagramVerificationSecret = String(
    env.RADAR_INSTAGRAM_VERIFICATION_SECRET || ""
  ).trim() || null;
  const openAiApiKey = String(env.OPENAI_API_KEY || "").trim() || null;
  const profilePrintSecuritySecret = String(
    env.RADAR_PROFILE_PRINT_SECURITY_SECRET || ""
  ).trim() || null;
  const profilePrintSafetyIdentifierSecret = String(
    env.RADAR_PROFILE_PRINT_SAFETY_IDENTIFIER_SECRET || ""
  ).trim() || null;
  const profilePrintOpenAiModel = String(
    env.RADAR_PROFILE_PRINT_OPENAI_MODEL || ""
  ).trim() || null;
  const requestedReasoningEffort = String(
    env.RADAR_PROFILE_PRINT_REASONING_EFFORT || "medium"
  ).trim().toLowerCase();
  const profilePrintReasoningEffort = PROFILE_PRINT_REASONING_EFFORTS.has(
    requestedReasoningEffort
  ) ? requestedReasoningEffort : null;
  const availabilityPageMaximum = boundedPositiveInteger(
    env.RADAR_AVAILABILITY_PAGE_MAXIMUM,
    50,
    100
  );
  const availabilityPageDefault = Math.min(
    boundedPositiveInteger(env.RADAR_AVAILABILITY_PAGE_DEFAULT, 20, 50),
    availabilityPageMaximum
  );
  const searchCursorSecret = String(
    env.RADAR_SEARCH_CURSOR_SECRET || ""
  ).trim() || null;
  const searchRateLimitSecret = String(
    env.RADAR_SEARCH_RATE_LIMIT_SECRET || ""
  ).trim() || null;
  const invitationsSecuritySecret = String(
    env.RADAR_INVITATIONS_SECURITY_SECRET || ""
  ).trim() || null;
  const matchResultsSecuritySecret = String(
    env.RADAR_MATCH_RESULTS_SECURITY_SECRET || ""
  ).trim() || null;
  const matchHistoryCursorSecret = String(
    env.RADAR_MATCH_HISTORY_CURSOR_SECRET || ""
  ).trim() || null;
  const matchHistoryRateLimitSecret = String(
    env.RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET || ""
  ).trim() || null;
  const reputationSecuritySecret = String(
    env.RADAR_REPUTATION_SECURITY_SECRET || ""
  ).trim() || null;
  const moderationSecuritySecret = String(
    env.RADAR_MODERATION_SECURITY_SECRET || ""
  ).trim() || null;
  const metricsToken = String(
    env.RADAR_METRICS_TOKEN || ""
  ).trim() || null;
  const searchPageMaximum = boundedPositiveInteger(
    env.RADAR_SEARCH_PAGE_MAXIMUM,
    24,
    50
  );
  const searchPageDefault = Math.min(
    boundedPositiveInteger(env.RADAR_SEARCH_PAGE_DEFAULT, 12, 24),
    searchPageMaximum
  );
  const invitationPageMaximum = boundedPositiveInteger(
    env.RADAR_INVITATION_PAGE_MAXIMUM,
    50,
    100
  );
  const invitationPageDefault = Math.min(
    boundedPositiveInteger(env.RADAR_INVITATION_PAGE_DEFAULT, 20, 50),
    invitationPageMaximum
  );
  const notificationPageMaximum = boundedPositiveInteger(
    env.RADAR_NOTIFICATION_PAGE_MAXIMUM,
    50,
    100
  );
  const notificationPageDefault = Math.min(
    boundedPositiveInteger(env.RADAR_NOTIFICATION_PAGE_DEFAULT, 20, 50),
    notificationPageMaximum
  );
  const config = {
    enabled: parseBoolean(env.RADAR_AMISTOSOS_ENABLED, false),
    searchEnabled: parseBoolean(env.RADAR_SEARCH_ENABLED, false),
    invitationsEnabled: parseBoolean(env.RADAR_INVITATIONS_ENABLED, false),
    matchCenterEnabled: parseBoolean(env.RADAR_MATCH_CENTER_ENABLED, false),
    matchResultsEnabled: parseBoolean(env.RADAR_MATCH_RESULTS_ENABLED, false),
    matchHistoryEnabled: parseBoolean(env.RADAR_MATCH_HISTORY_ENABLED, false),
    reputationEnabled: parseBoolean(env.RADAR_REPUTATION_ENABLED, false),
    moderationEnabled: parseBoolean(env.RADAR_MODERATION_ENABLED, false),
    profilePrintImportEnabled: parseBoolean(
      env.RADAR_PROFILE_PRINT_IMPORT_ENABLED,
      false
    ),
    pilotFree: parseBoolean(env.RADAR_AMISTOSOS_PILOT_FREE, true),
    pilotAccountAllowlistSize: pilotAccountAllowlist.length,
    pilotAccountAllowlistConfigured: pilotAccountAllowlist.length > 0,
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
    trustedProxyProvider: ["render"].includes(
      String(env.RADAR_TRUST_PROXY_PROVIDER || "").trim().toLowerCase()
    ) ? String(env.RADAR_TRUST_PROXY_PROVIDER).trim().toLowerCase() : null,
    trustedProxyHops: Math.min(
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
      Buffer.byteLength(profilePrintSecuritySecret, "utf8") >= 32 &&
      profilePrintSafetyIdentifierSecret &&
      Buffer.byteLength(profilePrintSafetyIdentifierSecret, "utf8") >= 32
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
    availabilityTimeZone: "America/Sao_Paulo",
    availabilityDefaultTravelRadiusKm: boundedPositiveInteger(
      env.RADAR_AVAILABILITY_DEFAULT_TRAVEL_RADIUS_KM,
      25,
      500
    ),
    availabilityMaxFuturePerTeam: boundedPositiveInteger(
      env.RADAR_AVAILABILITY_MAX_FUTURE_PER_TEAM,
      20,
      100
    ),
    availabilityMaxDurationHours: boundedPositiveInteger(
      env.RADAR_AVAILABILITY_MAX_DURATION_HOURS,
      12,
      24
    ),
    availabilityMaxHorizonDays: boundedPositiveInteger(
      env.RADAR_AVAILABILITY_MAX_HORIZON_DAYS,
      180,
      365
    ),
    availabilityRecurrenceMaxDays: boundedPositiveInteger(
      env.RADAR_AVAILABILITY_RECURRENCE_MAX_DAYS,
      90,
      180
    ),
    availabilityPageDefault,
    availabilityPageMaximum,
    searchConfigured: Boolean(
      searchCursorSecret &&
      Buffer.byteLength(searchCursorSecret, "utf8") >= 32 &&
      searchRateLimitSecret &&
      Buffer.byteLength(searchRateLimitSecret, "utf8") >= 32
    ),
    searchPageDefault,
    searchPageMaximum,
    searchRadiusMaximumKm: boundedPositiveInteger(
      env.RADAR_SEARCH_RADIUS_MAXIMUM_KM,
      100,
      500
    ),
    searchQueryTimeoutMs: boundedPositiveInteger(
      env.RADAR_SEARCH_QUERY_TIMEOUT_MS,
      1_500,
      10_000
    ),
    searchCursorTtlMinutes: boundedPositiveInteger(
      env.RADAR_SEARCH_CURSOR_TTL_MINUTES,
      15,
      120
    ),
    searchRateWindowSeconds: boundedPositiveInteger(
      env.RADAR_SEARCH_RATE_WINDOW_SECONDS,
      60,
      60 * 60
    ),
    searchAccountLimit: boundedPositiveInteger(
      env.RADAR_SEARCH_ACCOUNT_LIMIT,
      30,
      500
    ),
    searchTeamLimit: boundedPositiveInteger(
      env.RADAR_SEARCH_TEAM_LIMIT,
      30,
      500
    ),
    searchIpLimit: boundedPositiveInteger(
      env.RADAR_SEARCH_IP_LIMIT,
      120,
      2_000
    ),
    searchCandidateMaximum: boundedPositiveInteger(
      env.RADAR_SEARCH_CANDIDATE_MAXIMUM,
      500,
      5_000
    ),
    invitationsConfigured: Boolean(
      invitationsSecuritySecret &&
      Buffer.byteLength(invitationsSecuritySecret, "utf8") >= 32
    ),
    invitationExpirationHours: boundedPositiveInteger(
      env.RADAR_INVITATION_EXPIRATION_HOURS,
      72,
      7 * 24
    ),
    invitationMaxHorizonDays: boundedPositiveInteger(
      env.RADAR_INVITATION_MAX_HORIZON_DAYS,
      180,
      365
    ),
    invitationPageDefault,
    invitationPageMaximum,
    notificationPageDefault,
    notificationPageMaximum,
    matchCenterConfigured: Boolean(
      invitationsSecuritySecret &&
      Buffer.byteLength(invitationsSecuritySecret, "utf8") >= 32
    ),
    matchResultsConfigured: Boolean(
      matchResultsSecuritySecret &&
      Buffer.byteLength(matchResultsSecuritySecret, "utf8") >= 32
    ),
    matchHistoryConfigured: Boolean(
      matchHistoryCursorSecret &&
      Buffer.byteLength(matchHistoryCursorSecret, "utf8") >= 32 &&
      matchHistoryRateLimitSecret &&
      Buffer.byteLength(matchHistoryRateLimitSecret, "utf8") >= 32
    ),
    reputationConfigured: Boolean(
      reputationSecuritySecret &&
      Buffer.byteLength(reputationSecuritySecret, "utf8") >= 32
    ),
    moderationConfigured: Boolean(
      moderationSecuritySecret &&
      Buffer.byteLength(moderationSecuritySecret, "utf8") >= 32
    ),
    moderationRetentionDays: boundedPositiveInteger(
      env.RADAR_MODERATION_RETENTION_DAYS,
      365,
      3650
    ),
    moderationDescriptionMaximum: boundedPositiveInteger(
      env.RADAR_MODERATION_DESCRIPTION_MAXIMUM,
      500,
      500
    ),
    moderationRateWindowSeconds: boundedPositiveInteger(
      env.RADAR_MODERATION_RATE_WINDOW_SECONDS,
      60 * 60,
      24 * 60 * 60
    ),
    moderationAccountLimit: boundedPositiveInteger(
      env.RADAR_MODERATION_ACCOUNT_LIMIT,
      30,
      500
    ),
    moderationTeamLimit: boundedPositiveInteger(
      env.RADAR_MODERATION_TEAM_LIMIT,
      30,
      500
    ),
    moderationIpLimit: boundedPositiveInteger(
      env.RADAR_MODERATION_IP_LIMIT,
      120,
      2000
    ),
    moderationPageDefault: boundedPositiveInteger(
      env.RADAR_MODERATION_PAGE_DEFAULT,
      20,
      50
    ),
    moderationPageMaximum: boundedPositiveInteger(
      env.RADAR_MODERATION_PAGE_MAXIMUM,
      50,
      100
    ),
    technicalRetentionDays: boundedPositiveInteger(
      env.RADAR_TECHNICAL_RETENTION_DAYS,
      14,
      365
    ),
    retentionBatchMaximum: boundedPositiveInteger(
      env.RADAR_RETENTION_BATCH_MAXIMUM,
      500,
      5000
    ),
    metricsEnabled: parseBoolean(env.RADAR_METRICS_ENABLED, false),
    metricsConfigured: Boolean(
      metricsToken && Buffer.byteLength(metricsToken, "utf8") >= 32
    ),
    reputationMinimumVerifiedReviews: boundedPositiveInteger(
      env.RADAR_REPUTATION_MINIMUM_REVIEWS,
      3,
      100
    ),
    matchPageDefault: Math.min(
      boundedPositiveInteger(env.RADAR_MATCH_PAGE_DEFAULT, 20, 50),
      boundedPositiveInteger(env.RADAR_MATCH_PAGE_MAXIMUM, 50, 100)
    ),
    matchPageMaximum: boundedPositiveInteger(
      env.RADAR_MATCH_PAGE_MAXIMUM,
      50,
      100
    ),
    matchHistoryPageDefault: Math.min(
      boundedPositiveInteger(env.RADAR_MATCH_HISTORY_PAGE_DEFAULT, 20, 50),
      boundedPositiveInteger(env.RADAR_MATCH_HISTORY_PAGE_MAXIMUM, 50, 100)
    ),
    matchHistoryPageMaximum: boundedPositiveInteger(
      env.RADAR_MATCH_HISTORY_PAGE_MAXIMUM,
      50,
      100
    ),
    matchHistoryCursorTtlMinutes: boundedPositiveInteger(
      env.RADAR_MATCH_HISTORY_CURSOR_TTL_MINUTES,
      15,
      120
    ),
    matchHistoryRateWindowSeconds: boundedPositiveInteger(
      env.RADAR_MATCH_HISTORY_RATE_WINDOW_SECONDS,
      60,
      60 * 60
    ),
    matchHistoryAccountLimit: boundedPositiveInteger(
      env.RADAR_MATCH_HISTORY_ACCOUNT_LIMIT,
      60,
      1000
    ),
    matchHistoryTeamLimit: boundedPositiveInteger(
      env.RADAR_MATCH_HISTORY_TEAM_LIMIT,
      60,
      1000
    ),
    matchHistoryIpLimit: boundedPositiveInteger(
      env.RADAR_MATCH_HISTORY_IP_LIMIT,
      180,
      5000
    ),
    invitationRateWindowSeconds: boundedPositiveInteger(
      env.RADAR_INVITATION_RATE_WINDOW_SECONDS,
      60 * 60,
      24 * 60 * 60
    ),
    invitationAccountLimit: boundedPositiveInteger(
      env.RADAR_INVITATION_ACCOUNT_LIMIT,
      60,
      1_000
    ),
    invitationTeamLimit: boundedPositiveInteger(
      env.RADAR_INVITATION_TEAM_LIMIT,
      60,
      1_000
    ),
    invitationIpLimit: boundedPositiveInteger(
      env.RADAR_INVITATION_IP_LIMIT,
      180,
      5_000
    ),
    databaseUrl: String(env.DATABASE_URL || "").trim() || null,
    databaseSsl: parseBoolean(env.DATABASE_SSL, false),
    databaseSslRejectUnauthorized:
      parseBoolean(env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
    databaseSslCa: (() => {
      const encoded = String(env.DATABASE_SSL_CA_B64 || "").trim();
      if (!encoded) return null;
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
        return /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(decoded)
          ? decoded
          : null;
      } catch {
        return null;
      }
    })(),
    databaseConnectionTimeoutMs:
      parseOptionalPositiveInteger(env.DATABASE_CONNECTION_TIMEOUT_MS) || 5_000
  };
  Object.defineProperty(config, "pilotAccountAllowlist", {
    value: pilotAccountAllowlist,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "databaseEmbeddedPath", {
    value: databaseEmbeddedPath,
    enumerable: false,
    writable: false,
    configurable: false
  });
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
  Object.defineProperty(config, "profilePrintSafetyIdentifierSecret", {
    value: profilePrintSafetyIdentifierSecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "searchCursorSecret", {
    value: searchCursorSecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "searchRateLimitSecret", {
    value: searchRateLimitSecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "invitationsSecuritySecret", {
    value: invitationsSecuritySecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "matchResultsSecuritySecret", {
    value: matchResultsSecuritySecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "matchHistoryCursorSecret", {
    value: matchHistoryCursorSecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "matchHistoryRateLimitSecret", {
    value: matchHistoryRateLimitSecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "reputationSecuritySecret", {
    value: reputationSecuritySecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "moderationSecuritySecret", {
    value: moderationSecuritySecret,
    enumerable: false,
    writable: false,
    configurable: false
  });
  Object.defineProperty(config, "metricsToken", {
    value: metricsToken,
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
  boundedPositiveInteger,
  parsePilotAccountAllowlist
};
