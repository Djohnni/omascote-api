"use strict";

const express = require("express");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { createTeamReputationRepository } = require("./team-reputation.repository");
const { createTeamReputationService } = require("./team-reputation.service");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PRIVATE_POST = new RegExp(`^/amistosos/${UUID}/avaliacao$`, "i");
const PUBLIC_GET = new RegExp(`^/${UUID}/reputacao$`, "i");

function createTeamReputationRouters({ config, auth, pool, resolveIdentity, reputationService, logger = console }) {
  const service = reputationService || (pool
    ? createTeamReputationService({
        repository: createTeamReputationRepository({ pool }),
        config
      })
    : null);
  const privateRouter = express.Router();
  const publicRouter = express.Router();
  const parser = express.json({ limit: "4kb", strict: true });

  privateRouter.use((req, res, next) => {
    const handled = (req.method === "GET" && ["/avaliacoes/pendentes", "/reputacao"].includes(req.path)) ||
      (req.method === "POST" && PRIVATE_POST.test(req.path));
    return handled ? next() : next("router");
  });
  privateRouter.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (config?.enabled === true && config?.reputationEnabled === true) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  privateRouter.use((req, res, next) => {
    if (typeof auth !== "function" || typeof resolveIdentity !== "function" || !service) {
      return res.status(503).json({ ok: false, code: "RADAR_UNAVAILABLE", error: "Radar temporariamente indisponivel." });
    }
    return auth(req, res, next);
  });
  privateRouter.use(async (req, res, next) => {
    try {
      req.radarIdentity = await resolveIdentity(req.user);
      return next();
    } catch (error) { return next(error); }
  });

  privateRouter.get("/avaliacoes/pendentes", async (req, res, next) => {
    try {
      return res.json({ ok: true, ...await service.pending({ identity: req.radarIdentity }) });
    } catch (error) { return next(error); }
  });

  privateRouter.get("/reputacao", async (req, res, next) => {
    try {
      return res.json({ ok: true, ...await service.own({ identity: req.radarIdentity }) });
    } catch (error) { return next(error); }
  });

  function requireJson(req, res, next) {
    return req.is("application/json")
      ? next()
      : next(new RadarIdentityError("UNSUPPORTED_MEDIA_TYPE", 415, "Envie dados em formato JSON."));
  }

  privateRouter.post("/amistosos/:matchId/avaliacao", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.submit({
        identity: req.radarIdentity,
        publicId: req.params.matchId,
        body: req.body,
        idempotencyKey: req.get("Idempotency-Key"),
        requestId: req.get("X-Request-Id")
      });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  function errorHandler(route) {
    return (error, req, res, next) => {
      if (res.headersSent) return next(error);
      res.set("Cache-Control", "private, no-store");
      if (isRadarIdentityError(error)) {
        return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
      }
      if (error?.type === "entity.too.large") {
        return res.status(413).json({ ok: false, code: "TEAM_REVIEW_PAYLOAD_TOO_LARGE", error: "Dados muito grandes." });
      }
      if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
        return res.status(400).json({ ok: false, code: "INVALID_JSON", error: "JSON invalido." });
      }
      logger.error?.("[RADAR_TEAM_REPUTATION] request failed", {
        method: req.method, route, error: error?.name || "Error"
      });
      return res.status(500).json({ ok: false, code: "TEAM_REPUTATION_INTERNAL_ERROR", error: "Nao foi possivel carregar a reputacao." });
    };
  }
  privateRouter.use(errorHandler("/me/time/reputacao"));

  publicRouter.use((req, res, next) => {
    const handled = req.method === "GET" && PUBLIC_GET.test(req.path);
    return handled ? next() : next("router");
  });
  publicRouter.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (config?.enabled === true && config?.reputationEnabled === true) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  publicRouter.get("/:teamPublicId/reputacao", async (req, res, next) => {
    try {
      return res.json({ ok: true, ...await service.publicReputation({ teamPublicId: req.params.teamPublicId }) });
    } catch (error) { return next(error); }
  });
  publicRouter.use(errorHandler("/radar/times/:teamPublicId/reputacao"));

  return Object.freeze({ privateRouter, publicRouter });
}

module.exports = { createTeamReputationRouters };
