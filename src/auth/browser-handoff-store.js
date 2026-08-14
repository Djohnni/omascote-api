const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_TTL_MS = 180_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 300_000;
const DEFAULT_USED_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;

class BrowserHandoffStoreError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = "BrowserHandoffStoreError";
    this.code = code;
    this.cause = cause;
  }
}

function clampTtlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.min(Math.max(Math.trunc(parsed), MIN_TTL_MS), MAX_TTL_MS);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function emptyState() {
  return {
    version: 1,
    active: {},
    used: {},
    rate: []
  };
}

class BrowserHandoffStore {
  constructor(options = {}) {
    const filePath = String(options.filePath || "").trim();
    if (!filePath) throw new BrowserHandoffStoreError("file_path_required");

    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.ttlMs = clampTtlMs(options.ttlMs);
    this.usedRetentionMs = positiveInteger(
      options.usedRetentionMs,
      DEFAULT_USED_RETENTION_MS
    );
    this.rateWindowMs = positiveInteger(options.rateWindowMs, DEFAULT_RATE_WINDOW_MS);
    this.issueUserLimit = positiveInteger(options.issueUserLimit, 3);
    this.issueIpLimit = positiveInteger(options.issueIpLimit, 10);
    this.redeemIpLimit = positiveInteger(options.redeemIpLimit, 20);
    this.lockStaleMs = positiveInteger(options.lockStaleMs, 10_000);
    this.identifierSecret = String(
      options.identifierSecret || "browser-handoff-rate-v1"
    );
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === "function"
      ? options.randomBytes
      : crypto.randomBytes;
  }

  _identifierHash(scope, value) {
    return crypto
      .createHmac("sha256", this.identifierSecret)
      .update(`${scope}:${String(value || "unknown").slice(0, 300)}`, "utf8")
      .digest("hex");
  }

  _readState() {
    if (!fs.existsSync(this.filePath)) return emptyState();

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        parsed.version !== 1 ||
        !parsed.active ||
        typeof parsed.active !== "object" ||
        Array.isArray(parsed.active) ||
        !parsed.used ||
        typeof parsed.used !== "object" ||
        Array.isArray(parsed.used) ||
        !Array.isArray(parsed.rate)
      ) {
        throw new Error("invalid_state");
      }
      return parsed;
    } catch (error) {
      throw new BrowserHandoffStoreError("storage_unavailable", error);
    }
  }

  _writeState(state) {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${this.randomBytes(6).toString("hex")}.tmp`;

    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      throw new BrowserHandoffStoreError("storage_unavailable", error);
    }
  }

  _acquireLock() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return fs.openSync(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw new BrowserHandoffStoreError("storage_unavailable", error);
        }

        try {
          const stat = fs.statSync(this.lockPath);
          if (this.now() - stat.mtimeMs > this.lockStaleMs) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw new BrowserHandoffStoreError("storage_unavailable", statError);
        }

        throw new BrowserHandoffStoreError("storage_busy", error);
      }
    }

    throw new BrowserHandoffStoreError("storage_busy");
  }

  _withLock(callback) {
    const lockFd = this._acquireLock();

    try {
      return callback();
    } finally {
      try {
        fs.closeSync(lockFd);
      } catch {}
      try {
        if (fs.existsSync(this.lockPath)) fs.unlinkSync(this.lockPath);
      } catch {}
    }
  }

  _cleanup(state, now) {
    for (const [tokenHash, record] of Object.entries(state.active)) {
      if (Number(record?.expires_at || 0) > now) continue;

      delete state.active[tokenHash];
      state.used[tokenHash] = {
        reason: "expired",
        used_at: now,
        forget_at: now + this.usedRetentionMs
      };
    }

    for (const [tokenHash, record] of Object.entries(state.used)) {
      if (Number(record?.forget_at || 0) <= now) delete state.used[tokenHash];
    }

    state.rate = state.rate.filter(entry => (
      Number(entry?.at || 0) > now - this.rateWindowMs
    ));
  }

  _rateResult(state, scope, key, limit, now) {
    const matching = state.rate.filter(entry => (
      entry.scope === scope && entry.key === key
    ));

    if (matching.length < limit) return null;

    const oldest = Math.min(...matching.map(entry => Number(entry.at || now)));
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMs: Math.max(1_000, this.rateWindowMs - (now - oldest))
    };
  }

  issue({ userId, ipAddress, sessionExpiresAt }) {
    const normalizedUser = String(userId || "").trim();
    if (!normalizedUser || normalizedUser.length > 300) {
      throw new BrowserHandoffStoreError("invalid_user");
    }

    const normalizedSessionExpiry = Number(sessionExpiresAt);
    if (!Number.isFinite(normalizedSessionExpiry)) {
      throw new BrowserHandoffStoreError("invalid_session_expiry");
    }

    return this._withLock(() => {
      const now = Number(this.now());
      if (normalizedSessionExpiry <= now) {
        return { ok: false, reason: "session_expired" };
      }

      const state = this._readState();
      this._cleanup(state, now);

      const userHash = this._identifierHash("issue-user", normalizedUser);
      const ipHash = this._identifierHash("issue-ip", ipAddress || "unknown");
      const userLimited = this._rateResult(
        state,
        "issue_user",
        userHash,
        this.issueUserLimit,
        now
      );
      if (userLimited) return userLimited;

      const ipLimited = this._rateResult(
        state,
        "issue_ip",
        ipHash,
        this.issueIpLimit,
        now
      );
      if (ipLimited) return ipLimited;

      state.rate.push(
        { scope: "issue_user", key: userHash, at: now },
        { scope: "issue_ip", key: ipHash, at: now }
      );

      for (const [activeHash, record] of Object.entries(state.active)) {
        if (record?.user_hash !== userHash) continue;

        delete state.active[activeHash];
        state.used[activeHash] = {
          reason: "superseded",
          used_at: now,
          forget_at: now + this.usedRetentionMs
        };
      }

      let token = "";
      let tokenHash = "";
      do {
        token = this.randomBytes(32).toString("base64url");
        tokenHash = hashToken(token);
      } while (state.active[tokenHash] || state.used[tokenHash]);

      const expiresAt = Math.min(now + this.ttlMs, normalizedSessionExpiry);
      state.active[tokenHash] = {
        user_id: normalizedUser,
        user_hash: userHash,
        issued_at: now,
        expires_at: expiresAt,
        session_expires_at: normalizedSessionExpiry
      };

      this._writeState(state);
      return {
        ok: true,
        token,
        expiresAt,
        expiresInMs: expiresAt - now
      };
    });
  }

  redeem(token, { ipAddress } = {}) {
    const rawToken = String(token || "").trim();

    if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
      return { ok: false, reason: "invalid" };
    }

    return this._withLock(() => {
      const now = Number(this.now());
      const state = this._readState();
      this._cleanup(state, now);

      const ipHash = this._identifierHash("redeem-ip", ipAddress || "unknown");
      const ipLimited = this._rateResult(
        state,
        "redeem_ip",
        ipHash,
        this.redeemIpLimit,
        now
      );
      if (ipLimited) return ipLimited;

      state.rate.push({ scope: "redeem_ip", key: ipHash, at: now });

      const tokenHash = hashToken(rawToken);
      const previous = state.used[tokenHash];
      if (previous) {
        this._writeState(state);
        return { ok: false, reason: previous.reason || "used" };
      }

      const record = state.active[tokenHash];
      if (!record) {
        this._writeState(state);
        return { ok: false, reason: "invalid" };
      }

      if (Number(record.expires_at || 0) <= now) {
        delete state.active[tokenHash];
        state.used[tokenHash] = {
          reason: "expired",
          used_at: now,
          forget_at: now + this.usedRetentionMs
        };
        this._writeState(state);
        return { ok: false, reason: "expired" };
      }

      delete state.active[tokenHash];
      state.used[tokenHash] = {
        reason: "used",
        used_at: now,
        forget_at: now + this.usedRetentionMs
      };
      this._writeState(state);

      return {
        ok: true,
        record: { ...record },
        ageMs: Math.max(0, now - Number(record.issued_at || now))
      };
    });
  }
}

module.exports = {
  BrowserHandoffStore,
  BrowserHandoffStoreError,
  clampTtlMs,
  hashToken
};
