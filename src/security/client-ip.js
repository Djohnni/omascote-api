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

function forwardedAddresses(req) {
  const raw = String(req.get?.("X-Forwarded-For") || req.headers?.["x-forwarded-for"] || "");
  if (raw.length > 2_048) return [];
  return raw.split(",").map(value => value.trim()).filter(Boolean).slice(-16);
}

function clientIp(req, config = {}) {
  const provider = String(config.trustedProxyProvider || "").trim().toLowerCase();
  const hops = Number(config.trustedProxyHops ?? config.instagramTrustedProxyHops ?? 0);
  const socketAddress = normalizeAddress(req.socket?.remoteAddress);

  // Use only the position proved from the right-hand trusted proxy chain.
  // Client-supplied values are prepended on the left and cannot move this slot.
  if (provider === "render" && Number.isInteger(hops) && hops >= 1 && hops <= 5) {
    const forwarded = forwardedAddresses(req);
    const selected = forwarded.length >= hops ? forwarded[forwarded.length - hops] : null;
    return normalizeAddress(selected) || socketAddress || "unknown";
  }
  return normalizeAddress(req.ip) || socketAddress || "unknown";
}

module.exports = { clientIp, firstForwardedAddress, forwardedAddresses, normalizeAddress };
