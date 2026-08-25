"use strict";

const net = require("node:net");

function normalizeAddress(value) {
  let candidate = String(value || "").trim();
  if (candidate.startsWith('"') && candidate.endsWith('"')) candidate = candidate.slice(1, -1).trim();
  if (candidate.toLowerCase().startsWith("::ffff:")) candidate = candidate.slice(7);
  const zoneIndex = candidate.indexOf("%");
  if (zoneIndex > -1) candidate = candidate.slice(0, zoneIndex);
  return net.isIP(candidate) ? candidate.toLowerCase() : null;
}

function firstForwardedAddress(req) {
  const raw = String(req.get?.("X-Forwarded-For") || req.headers?.["x-forwarded-for"] || "");
  if (raw.length > 2_048) return null;
  const first = raw.split(",", 1)[0];
  return normalizeAddress(first);
}

function clientIp(req, config = {}) {
  const provider = String(config.trustedProxyProvider || "").trim().toLowerCase();
  const hops = Number(config.trustedProxyHops ?? config.instagramTrustedProxyHops ?? 0);
  const socketAddress = normalizeAddress(req.socket?.remoteAddress);

  // Render guarantees that its edge writes the real client address as the first
  // X-Forwarded-For item. Values supplied by the client can only follow it and
  // are deliberately ignored here.
  if (provider === "render" && hops === 1) {
    return firstForwardedAddress(req) || socketAddress || "unknown";
  }
  return normalizeAddress(req.ip) || socketAddress || "unknown";
}

module.exports = { clientIp, firstForwardedAddress, normalizeAddress };
