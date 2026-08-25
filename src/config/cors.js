"use strict";

const PRODUCTION_ORIGINS = Object.freeze([
  "https://omascote.com.br",
  "https://www.omascote.com.br"
]);

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 300) return null;
  try {
    const parsed = new URL(raw);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function createCorsOriginAllowlist(env = process.env) {
  const includeProduction = !["0", "false", "off", "no"].includes(
    String(env.OMASCOTE_CORS_INCLUDE_PRODUCTION_ORIGINS || "true").trim().toLowerCase()
  );
  const configured = String(env.OMASCOTE_CORS_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return Object.freeze([...new Set([
    ...(includeProduction ? PRODUCTION_ORIGINS : []),
    ...configured
  ])]);
}

module.exports = { PRODUCTION_ORIGINS, normalizeOrigin, createCorsOriginAllowlist };
