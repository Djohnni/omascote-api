"use strict";

const express = require("express");
const { clientIp } = require("../security/client-ip");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { rowToTeam } = require("./radar-identity.repository");
const { assertRadarTeamOwnedByIdentity, assertRadarTeamCanMutate } = require("./radar-identity.policy");
const { buildRadarEligibility } = require("./radar-identity.service");
const {
  decryptWhatsapp,
  requireWhatsappConfiguration,
  whatsappScopeHash
} = require("./radar-whatsapp.crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createRadarWhatsappRouter({ config, auth, pool, resolveIdentity, logger = console }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!config.enabled) return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
    if (typeof auth !== "function" || typeof resolveIdentity !== "function" || !pool) {
      return res.status(503).json({ ok: false, code: "RADAR_UNAVAILABLE", error: "Radar temporariamente indisponivel." });
    }
    return auth(req, res, next);
  });

  router.use(async (req, res, next) => {
    try {
      req.radarIdentity = await resolveIdentity(req.user);
      return next();
    } catch (error) { return next(error); }
  });

  router.get("/:teamPublicId/whatsapp", async (req, res, next) => {
    const publicId = String(req.params.teamPublicId || "").trim().toLowerCase();
    if (!UUID.test(publicId)) return next(new RadarIdentityError("RADAR_TEAM_NOT_FOUND", 404, "Time indisponivel."));
    let client;
    let open = false;
    try {
      requireWhatsappConfiguration(config);
      client = await pool.connect();
      await client.query("BEGIN");
      open = true;
      const originResult = await client.query(
        "SELECT * FROM radar_team_profiles WHERE legacy_profile_id = $1 FOR UPDATE",
        [req.radarIdentity.profileId]
      );
      if (originResult.rowCount !== 1) throw new RadarIdentityError("RADAR_PROFILE_NOT_FOUND", 409, "Perfil do Radar indisponivel.");
      const origin = rowToTeam(originResult.rows[0]);
      assertRadarTeamOwnedByIdentity(origin, req.radarIdentity);
      assertRadarTeamCanMutate(origin);
      const eligibility = buildRadarEligibility({ team: origin, legacyProfile: req.radarIdentity.legacyProfile, config });
      if (!eligibility.eligible) {
        throw new RadarIdentityError("RADAR_WHATSAPP_ORIGIN_INELIGIBLE", 403, "Contato indisponivel.");
      }
      const targetResult = await client.query(`
        SELECT * FROM radar_team_profiles
        WHERE public_id = $1 AND id <> $2
          AND status = 'active' AND suspended_at IS NULL
          AND radar_departed_at IS NULL AND radar_visible = true
          AND whatsapp_visible = true AND whatsapp_ciphertext IS NOT NULL
        FOR SHARE
      `, [publicId, origin.id]);
      if (targetResult.rowCount !== 1) throw new RadarIdentityError("RADAR_TEAM_NOT_FOUND", 404, "Time indisponivel.");
      const target = rowToTeam(targetResult.rows[0]);
      const blocked = await client.query(`
        SELECT 1 FROM team_blocks
        WHERE (blocker_team_id = $1 AND blocked_team_id = $2)
           OR (blocker_team_id = $2 AND blocked_team_id = $1)
        LIMIT 1
      `, [origin.id, target.id]);
      if (blocked.rowCount) throw new RadarIdentityError("RADAR_TEAM_NOT_FOUND", 404, "Time indisponivel.");

      const now = new Date();
      const windowMs = config.whatsappRateWindowSeconds * 1000;
      const windowStartedAt = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
      const rawIp = clientIp(req, config) || "unknown";
      const scopes = [
        ["account", whatsappScopeHash(config.whatsappRateLimitSecret, "account", req.radarIdentity.accountId), config.whatsappAccountLimit],
        ["team", whatsappScopeHash(config.whatsappRateLimitSecret, "team", origin.id), config.whatsappTeamLimit],
        ["ip", whatsappScopeHash(config.whatsappRateLimitSecret, "ip", rawIp), config.whatsappIpLimit]
      ];
      for (const [scopeType, scopeHash, limit] of scopes) {
        const consumed = await client.query(`
          INSERT INTO radar_whatsapp_release_limits(scope_type, scope_hash, window_started_at, request_count, updated_at)
          VALUES ($1, $2, $3, 1, $4)
          ON CONFLICT (scope_type, scope_hash, window_started_at)
          DO UPDATE SET request_count = radar_whatsapp_release_limits.request_count + 1, updated_at = EXCLUDED.updated_at
          WHERE radar_whatsapp_release_limits.request_count < $5
          RETURNING request_count
        `, [scopeType, scopeHash, windowStartedAt, now, limit]);
        if (consumed.rowCount !== 1) throw new RadarIdentityError("RADAR_WHATSAPP_RATE_LIMITED", 429, "Limite de contatos atingido.");
      }

      const number = decryptWhatsapp(target.whatsappCiphertext, target.whatsappKeyVersion, config);
      await client.query(`
        INSERT INTO match_audit_events(actor_team_id, actor_reference, event_type, payload, request_id)
        VALUES ($1, $2, 'radar_whatsapp.released', $3::jsonb, $4)
      `, [origin.id, req.radarIdentity.accountId, JSON.stringify({ target_public_id: target.publicId, channel: "whatsapp" }), req.get("X-Request-Id") || null]);
      await client.query("COMMIT");
      open = false;
      return res.json({ ok: true, whatsapp_url: `https://wa.me/${number.replace(/\D/g, "")}` });
    } catch (error) {
      if (open) { try { await client.query("ROLLBACK"); } catch {} }
      return next(error);
    } finally {
      client?.release?.();
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    logger.error?.("[RADAR_WHATSAPP] request failed", { method: req.method, route: "/radar/times/:id/whatsapp", error: error?.name || "Error" });
    return res.status(500).json({ ok: false, code: "RADAR_WHATSAPP_INTERNAL_ERROR", error: "Contato temporariamente indisponivel." });
  });

  return router;
}

module.exports = { createRadarWhatsappRouter };
