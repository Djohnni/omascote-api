const crypto = require("node:crypto");

// Separate capability store: unlike one-use POST tickets, native downloads
// must tolerate HEAD, retries and Range requests during their short lifetime.
class DownloadLinkStore {
  constructor({ now = Date.now, ttlMs = 300_000, maxEntries = 5000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.records = new Map();
  }

  hash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  issue({ userId, resourceId, format }) {
    if (!userId || !resourceId || !["resultado", "video"].includes(format)) {
      throw new Error("invalid_download_link_resource");
    }
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
    if (this.records.size >= this.maxEntries) throw new Error("download_link_capacity");
    const token = crypto.randomBytes(32).toString("base64url");
    this.records.set(this.hash(token), Object.freeze({
      userId, resourceId, format, expiresAt: now + this.ttlMs
    }));
    return { token, expiresInMs: this.ttlMs };
  }

  resolve(token, { resourceId, format }) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = this.hash(token);
    const record = this.records.get(key);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.records.delete(key);
      return null;
    }
    if (record.resourceId !== resourceId || record.format !== format) return null;
    return record;
  }
}

module.exports = { DownloadLinkStore };
