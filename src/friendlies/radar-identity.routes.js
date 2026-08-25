"use strict";

const express = require("express");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { createRadarIdentityRepository } = require("./radar-identity.repository");
const { createRadarIdentityService } = require("./radar-identity.service");

function createRadarIdentityRouter({
  config,
  auth,
  pool,
  resolveIdentity,
  identityService,
  logger = console
}) {
  const router = express.Router();
  const radarJsonParser = express.json({ limit: "16kb", strict: true });
  const service = identityService || (pool
    ? createRadarIdentityService({
      repository: createRadarIdentityRepository({ pool }),
      config
    })
    : null);

  router.use((req, res, next) => {
    if (config.enabled) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });

  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (typeof auth !== "function" || typeof resolveIdentity !== "function" || !service) {
      return res.status(503).json({
        ok: false,
        code: "RADAR_UNAVAILABLE",
        error: "Radar de Amistosos temporariamente indisponivel."
      });
    }
    return auth(req, res, next);
  });

  router.use(async (req, res, next) => {
    try {
      req.radarIdentity = await resolveIdentity(req.user);
      return next();
    } catch (error) {
      return next(error);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const result = await service.getProfile(req.radarIdentity);
      if (result.profile?.version) res.set("ETag", `W/\"${result.profile.version}\"`);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/elegibilidade", async (req, res, next) => {
    try {
      const result = await service.getProfile(req.radarIdentity);
      return res.json({
        ok: true,
        profile: result.profile,
        legacy_profile: result.legacy_profile,
        eligibility: result.eligibility,
        onboarding: result.onboarding
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch("/", (req, res, next) => {
    if (req.is("application/json")) return next();
    return next(new RadarIdentityError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Envie os dados do Radar em formato JSON."
    ));
  }, radarJsonParser, async (req, res, next) => {
    try {
      const result = await service.putProfile({
        identity: req.radarIdentity,
        body: req.body,
        idempotencyKey: req.get("Idempotency-Key"),
        expectedVersion: req.get("If-Match"),
        requestId: req.get("X-Request-Id")
      });
      if (result.profile?.version) res.set("ETag", `W/\"${result.profile.version}\"`);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");

    if (isRadarIdentityError(error)) {
      const body = { ok: false, code: error.code, error: error.message };
      if (Array.isArray(error.details?.missing)) {
        body.missing = error.details.missing;
      }
      return res.status(error.status).json(body);
    }

    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        ok: false,
        code: "RADAR_PAYLOAD_TOO_LARGE",
        error: "Dados do Radar muito grandes."
      });
    }
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      return res.status(400).json({
        ok: false,
        code: "INVALID_JSON",
        error: "Dados do Radar invalidos."
      });
    }

    logger.error?.("[RADAR_IDENTITY] request failed", {
      method: req.method,
      path: req.originalUrl,
      error: error?.name || "Error"
    });
    return res.status(500).json({
      ok: false,
      code: "RADAR_INTERNAL_ERROR",
      error: "Nao foi possivel processar a solicitacao do Radar."
    });
  });

  return router;
}

module.exports = { createRadarIdentityRouter };
