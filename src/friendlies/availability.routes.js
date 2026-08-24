"use strict";

const express = require("express");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { createAvailabilityRepository } = require("./availability.repository");
const { createAvailabilityService } = require("./availability.service");

function etag(response, result) {
  const version = result?.availability?.version;
  if (Number.isInteger(version) && version > 0) response.set("ETag", `W/\"${version}\"`);
}

function createAvailabilityRouter({
  config,
  auth,
  pool,
  resolveIdentity,
  availabilityService,
  logger = console
}) {
  const router = express.Router();
  const parser = express.json({ limit: "16kb", strict: true });
  const service = availabilityService || (pool
    ? createAvailabilityService({
      repository: createAvailabilityRepository({ pool }),
      config
    })
    : null);

  router.use((req, res, next) => {
    if (config?.enabled === true) return next();
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

  router.get("/disponibilidades", async (req, res, next) => {
    try {
      const result = await service.list({ identity: req.radarIdentity, query: req.query });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    "/disponibilidades",
    (req, res, next) => req.is("application/json")
      ? next()
      : next(new RadarIdentityError(
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "Envie a disponibilidade em formato JSON."
      )),
    parser,
    async (req, res, next) => {
      try {
        const result = await service.create({
          identity: req.radarIdentity,
          body: req.body,
          idempotencyKey: req.get("Idempotency-Key"),
          requestId: req.get("X-Request-Id")
        });
        etag(res, result);
        return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.patch(
    "/disponibilidades/:id",
    (req, res, next) => req.is("application/json")
      ? next()
      : next(new RadarIdentityError(
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "Envie a disponibilidade em formato JSON."
      )),
    parser,
    async (req, res, next) => {
      try {
        const result = await service.update({
          identity: req.radarIdentity,
          publicId: req.params.id,
          body: req.body,
          expectedVersion: req.get("If-Match"),
          idempotencyKey: req.get("Idempotency-Key"),
          requestId: req.get("X-Request-Id")
        });
        etag(res, result);
        return res.json({ ok: true, ...result });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.delete("/disponibilidades/:id", async (req, res, next) => {
    try {
      const result = await service.cancel({
        identity: req.radarIdentity,
        publicId: req.params.id,
        expectedVersion: req.get("If-Match"),
        idempotencyKey: req.get("Idempotency-Key"),
        requestId: req.get("X-Request-Id")
      });
      etag(res, result);
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
      if (Array.isArray(error.details?.missing)) body.missing = error.details.missing;
      return res.status(error.status).json(body);
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        ok: false,
        code: "AVAILABILITY_PAYLOAD_TOO_LARGE",
        error: "Dados da disponibilidade muito grandes."
      });
    }
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      return res.status(400).json({
        ok: false,
        code: "INVALID_JSON",
        error: "Dados da disponibilidade invalidos."
      });
    }
    logger.error?.("[RADAR_AVAILABILITY] request failed", {
      method: req.method,
      route: "/me/time/amistosos/disponibilidades",
      error: error?.name || "Error"
    });
    return res.status(500).json({
      ok: false,
      code: "AVAILABILITY_INTERNAL_ERROR",
      error: "Nao foi possivel processar a disponibilidade."
    });
  });

  return router;
}

module.exports = { createAvailabilityRouter, etag };
