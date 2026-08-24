"use strict";

const express = require("express");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { createMatchCenterRepository } = require("./match-center.repository");
const { createMatchCenterService } = require("./match-center.service");

const MATCH_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/(?:confirmar-realizacao|cancelar))?$/i;

function setMatchEtag(res, result) {
  const version = result?.match?.version;
  if (Number.isInteger(version) && version > 0) res.set("ETag", `W/\"${version}\"`);
}

function createMatchCenterRouter({ config, auth, pool, resolveIdentity, resolveContact, matchService, logger = console }) {
  const service = matchService || (pool
    ? createMatchCenterService({
        repository: createMatchCenterRepository({ pool }),
        config,
        resolveContact
      })
    : null);
  const router = express.Router();
  const parser = express.json({ limit: "8kb", strict: true });

  router.use((req, res, next) => {
    const handled = (req.method === "GET" && req.path === "/") || MATCH_PATH.test(req.path);
    return handled ? next() : next("router");
  });

  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (config?.enabled === true && config?.matchCenterEnabled === true) return next();
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

  router.get("/", async (req, res, next) => {
    try {
      const result = await service.list({ identity: req.radarIdentity, query: req.query });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.get("/:matchId", async (req, res, next) => {
    try {
      const result = await service.get({ identity: req.radarIdentity, publicId: req.params.matchId });
      setMatchEtag(res, result);
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.post("/:matchId/confirmar-realizacao", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.confirmOccurrence(context(req));
      setMatchEtag(res, result);
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.post("/:matchId/cancelar", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.cancel(context(req));
      setMatchEtag(res, result);
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
      return res.status(413).json({ ok: false, code: "MATCH_PAYLOAD_TOO_LARGE", error: "Dados muito grandes." });
    }
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      return res.status(400).json({ ok: false, code: "INVALID_JSON", error: "JSON invalido." });
    }
    logger.error?.("[RADAR_MATCH_CENTER] request failed", {
      method: req.method,
      route: "/me/time/amistosos",
      error: error?.name || "Error"
    });
    return res.status(500).json({ ok: false, code: "MATCH_INTERNAL_ERROR", error: "Nao foi possivel processar a partida." });
  });

  return router;
}

module.exports = { createMatchCenterRouter, setMatchEtag };
