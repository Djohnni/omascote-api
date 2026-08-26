"use strict";

const { createCorsOriginAllowlist } = require("./cors");
const { readJwtSecret } = require("./auth");

const RADAR_FLAGS = Object.freeze([
  "RADAR_AMISTOSOS_ENABLED", "RADAR_SEARCH_ENABLED", "RADAR_INVITATIONS_ENABLED",
  "RADAR_MATCH_CENTER_ENABLED", "RADAR_MATCH_RESULTS_ENABLED", "RADAR_MATCH_HISTORY_ENABLED",
  "RADAR_REPUTATION_ENABLED", "RADAR_MODERATION_ENABLED", "RADAR_PROFILE_PRINT_IMPORT_ENABLED"
]);
const PURPOSE_SECRETS = Object.freeze([
  "RADAR_SEARCH_CURSOR_SECRET",
  "RADAR_SEARCH_RATE_LIMIT_SECRET",
  "RADAR_INVITATIONS_SECURITY_SECRET",
  "RADAR_MATCH_RESULTS_SECURITY_SECRET",
  "RADAR_MATCH_HISTORY_CURSOR_SECRET",
  "RADAR_MATCH_HISTORY_RATE_LIMIT_SECRET",
  "RADAR_REPUTATION_SECURITY_SECRET",
  "RADAR_MODERATION_SECURITY_SECRET",
  "RADAR_METRICS_TOKEN"
]);

function truthy(value) {
  return ["1", "true", "on", "yes"].includes(String(value || "").trim().toLowerCase());
}

function validateStagingEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];
  const environment = String(env.NODE_ENV || "").trim().toLowerCase();
  if (environment !== "staging") errors.push("NODE_ENV must be staging");

  try {
    const jwt = readJwtSecret(env);
    if (Buffer.byteLength(jwt, "utf8") < 32) errors.push("JWT_SECRET must have at least 32 bytes in staging");
  } catch (error) {
    errors.push(error.message);
  }

  let databaseUrl;
  try { databaseUrl = new URL(String(env.DATABASE_URL || "")); } catch { databaseUrl = null; }
  if (!databaseUrl || !["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    errors.push("DATABASE_URL must use managed PostgreSQL");
  }
  if (!truthy(env.DATABASE_SSL)) errors.push("DATABASE_SSL must be true");
  if (!truthy(env.DATABASE_SSL_REJECT_UNAUTHORIZED)) {
    errors.push("DATABASE_SSL_REJECT_UNAUTHORIZED must be true");
  }

  const origins = createCorsOriginAllowlist(env);
  if (truthy(env.OMASCOTE_CORS_INCLUDE_PRODUCTION_ORIGINS)) {
    errors.push("Staging must not automatically include production CORS origins");
  }
  if (!origins.length || origins.some(origin => !origin.startsWith("https://") || /localhost|127\.0\.0\.1/i.test(origin))) {
    errors.push("OMASCOTE_CORS_ORIGINS must contain only HTTPS staging origins");
  }

  const proxyHops = Number(env.RADAR_TRUST_PROXY_HOPS);
  if (!Number.isInteger(proxyHops) || proxyHops < 1 || proxyHops > 5) {
    errors.push("RADAR_TRUST_PROXY_HOPS must match the staging proxy chain (1-5)");
  }

  for (const flag of RADAR_FLAGS) {
    if (truthy(env[flag])) errors.push(`${flag} must remain false before staging authorization`);
  }
  if (String(env.OPENAI_API_KEY || "").trim()) warnings.push("OPENAI_API_KEY is present although AI import is disabled");

  const values = new Map();
  for (const name of PURPOSE_SECRETS) {
    const value = String(env[name] || "").trim();
    if (Buffer.byteLength(value, "utf8") < 32) {
      errors.push(`${name} must have at least 32 bytes`);
      continue;
    }
    if (values.has(value)) errors.push(`${name} must differ from ${values.get(value)}`);
    else values.set(value, name);
  }

  if (!truthy(env.RADAR_METRICS_ENABLED)) errors.push("RADAR_METRICS_ENABLED must be true in staging");
  if (!String(env.COMMIT_SHA || env.RENDER_GIT_COMMIT || "").trim()) errors.push("Commit metadata is required");
  if (!String(env.RELEASE_VERSION || env.BUILD_ID || "").trim()) errors.push("Release version metadata is required");

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    summary: Object.freeze({
      environment,
      cors_origin_count: origins.length,
      proxy_hops: Number.isInteger(proxyHops) ? proxyHops : null,
      participation: "automatic",
      separated_secrets: values.size,
      flags_enabled: RADAR_FLAGS.filter(name => truthy(env[name])).length,
      openai_enabled: truthy(env.RADAR_PROFILE_PRINT_IMPORT_ENABLED)
    })
  });
}

module.exports = { RADAR_FLAGS, PURPOSE_SECRETS, validateStagingEnvironment };
