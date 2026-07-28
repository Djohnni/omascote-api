const crypto = require("crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function normalizeRequired(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`download_ticket_${field}_required`);
  return normalized;
}

class DownloadTicketStore {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || 90_000);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === "function"
      ? options.randomBytes
      : crypto.randomBytes;
    this.active = new Map();
    this.used = new Map();
  }

  cleanup() {
    const now = this.now();

    for (const [key, record] of this.active) {
      if (record.expiresAt <= now) this.active.delete(key);
    }

    for (const [key, expiresAt] of this.used) {
      if (expiresAt <= now) this.used.delete(key);
    }
  }

  issue({ resourceType, resourceId, userId, metadata = {} }) {
    this.cleanup();

    const normalizedType = normalizeRequired(resourceType, "resource_type");
    const normalizedId = normalizeRequired(resourceId, "resource_id");
    const normalizedUser = normalizeRequired(userId, "user_id");

    let token = "";
    let key = "";

    do {
      token = this.randomBytes(32).toString("base64url");
      key = hashToken(token);
    } while (this.active.has(key) || this.used.has(key));

    const issuedAt = this.now();
    const record = Object.freeze({
      resourceType: normalizedType,
      resourceId: normalizedId,
      userId: normalizedUser,
      metadata: { ...metadata },
      issuedAt,
      expiresAt: issuedAt + this.ttlMs
    });

    this.active.set(key, record);

    return {
      token,
      expiresAt: record.expiresAt,
      expiresInMs: this.ttlMs
    };
  }

  redeem(token, { resourceType, resourceId }) {
    const rawToken = String(token || "").trim();

    if (!/^[A-Za-z0-9_-]{40,60}$/.test(rawToken)) {
      return { ok: false, reason: "invalid" };
    }

    const key = hashToken(rawToken);
    const now = this.now();
    const record = this.active.get(key);

    if (!record) {
      this.cleanup();
      return {
        ok: false,
        reason: this.used.has(key) ? "used" : "invalid"
      };
    }

    if (record.expiresAt <= now) {
      this.active.delete(key);
      return { ok: false, reason: "expired" };
    }

    if (
      record.resourceType !== String(resourceType || "").trim() ||
      record.resourceId !== String(resourceId || "").trim()
    ) {
      return { ok: false, reason: "resource_mismatch" };
    }

    // A exclusao ocorre antes de devolver o registro para impedir dois resgates
    // concorrentes do mesmo ticket.
    this.active.delete(key);
    this.used.set(key, record.expiresAt);

    return { ok: true, record };
  }
}

function safeDownloadFilename(value, fallback = "arquivo") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 140);

  return normalized || fallback;
}

function attachmentContentDisposition(filename) {
  const safe = safeDownloadFilename(filename);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

module.exports = {
  DownloadTicketStore,
  attachmentContentDisposition,
  safeDownloadFilename
};
