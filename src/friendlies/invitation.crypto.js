"use strict";

const crypto = require("node:crypto");
const { invitationError } = require("./invitation.schemas");

function secret(config) {
  const value = config?.invitationsSecuritySecret;
  if (!config?.invitationsConfigured || !value || Buffer.byteLength(value, "utf8") < 32) {
    throw invitationError("INVITATIONS_CONFIGURATION_UNAVAILABLE", 503, "Convites temporariamente indisponiveis.");
  }
  return value;
}

function hmac(config, context, value) {
  return crypto.createHmac("sha256", secret(config)).update(`${context}:${value}`).digest("hex");
}

function invitationRateHash(config, type, value) {
  return hmac(config, `invitation-rate-${type}-v1`, String(value || "unknown"));
}

function encodeNotificationCursor(config, value) {
  const data = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = hmac(config, "notification-cursor-v1", data);
  return `${data}.${signature}`;
}

function decodeNotificationCursor(config, cursor) {
  const raw = String(cursor || "").trim();
  const [data, signature, extra] = raw.split(".");
  if (!data || !signature || extra || !/^[A-Za-z0-9_-]{1,1024}$/.test(data) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw invitationError("NOTIFICATION_CURSOR_INVALID", 400, "Cursor de notificacao invalido.");
  }
  const expected = hmac(config, "notification-cursor-v1", data);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw invitationError("NOTIFICATION_CURSOR_INVALID", 400, "Cursor de notificacao invalido.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(String(parsed.public_id || ""))) throw new Error();
    return Object.freeze({ createdAt: createdAt.toISOString(), publicId: String(parsed.public_id).toLowerCase() });
  } catch {
    throw invitationError("NOTIFICATION_CURSOR_INVALID", 400, "Cursor de notificacao invalido.");
  }
}

module.exports = { invitationRateHash, encodeNotificationCursor, decodeNotificationCursor };
