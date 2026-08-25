"use strict";

const express = require("express");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { createMatchResultRepository } = require("./match-result.repository");
const { createMatchResultService } = require("./match-result.service");

const RESULT_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/resultado(?:\/confirmar)?$/i;

function setResultEtag(res, result) {
  const version = result?.match?.version;
  if (Number.isInteger(version) && version > 0) res.set("ETag", `W/\"${version}\"`);
}

function createMatchResultRouter({ config, auth, pool, resolveIdentity, resultService, logger = console }) {
  const service = resultService || (pool
    ? createMatchResultService({
        repository: createMatchResultRepository({ pool, config }),
        config
      })
    : null);
  const router = express.Router();
  const parser = express.json({ limit: "4kb", strict: true });

  router.use((req, res, next) => RESULT_PATH.test(req.path) ? next() : next("router"));
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (config?.enabled === true && config?.matchResultsEnabled === true) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  router.use((req, res, next) => {
    if (typeof auth !== "function" || typeof resolveIdentity !== "function" || !service) {
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

  function requireJson(req, res, next) {
    return req.is("application/json")
      ? next()
      : next(new RadarIdentityError("UNSUPPORTED_MEDIA_TYPE", 415, "Envie dados em formato JSON."));
  }

  function context(req) {
    return {
      identity: req.radarIdentity,
      publicId: req.params.matchId,
      body: req.body,
      idempotencyKey: req.get("Idempotency-Key"),
      expectedVersion: req.get("If-Match"),
      requestId: req.get("X-Request-Id")
    };
  }

  router.post("/:matchId/resultado", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.submit(context(req));
      setResultEtag(res, result);
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.post("/:matchId/resultado/confirmar", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.confirm(context(req));
      setResultEtag(res, result);
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) {
      return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ ok: false, code: "MATCH_RESULT_PAYLOAD_TOO_LARGE", error: "Dados muito grandes." });
    }
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      return res.status(400).json({ ok: false, code: "INVALID_JSON", error: "JSON invalido." });
    }
    logger.error?.("[RADAR_MATCH_RESULT] request failed", {
      method: req.method,
      route: "/me/time/amistosos/:matchId/resultado",
      error: error?.name || "Error"
    });
    return res.status(500).json({ ok: false, code: "MATCH_RESULT_INTERNAL_ERROR", error: "Nao foi possivel processar o placar." });
  });

  return router;
}

module.exports = { createMatchResultRouter, setResultEtag };
