"use strict";

const express = require("express");
const { isRadarIdentityError } = require("./radar-identity.errors");
const { createMatchHistoryRepository } = require("./match-history.repository");
const { createMatchHistoryService } = require("./match-history.service");
const { clientIp } = require("./friendly-search.routes");

const OPPONENT_PATH = /^\/historico\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createMatchHistoryRouter({
  config,
  auth,
  pool,
  resolveIdentity,
  historyService,
  logger = console
}) {
  const service = historyService || (pool
    ? createMatchHistoryService({
        repository: createMatchHistoryRepository({ pool, config }),
        config
      })
    : null);
  const router = express.Router();

  router.use((req, res, next) => {
    const handled = req.method === "GET" &&
      (req.path === "/historico" || OPPONENT_PATH.test(req.path));
    return handled ? next() : next("router");
  });
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (config?.enabled === true && config?.matchHistoryEnabled === true) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  router.use((req, res, next) => {
    if (typeof auth !== "function" || typeof resolveIdentity !== "function" || !service) {
      return res.status(503).json({
        ok: false,
        code: "RADAR_UNAVAILABLE",
        error: "Radar temporariamente indisponivel."
      });
    }
    return auth(req, res, next);
  });
  router.use(async (req, res, next) => {
    try {
      req.radarIdentity = await resolveIdentity(req.user);
      return next();
    } catch (error) { return next(error); }
  });

  router.get("/historico", async (req, res, next) => {
    try {
      const result = await service.list({
        identity: req.radarIdentity,
        query: req.query,
        requestContext: { ip: clientIp(req, config) }
      });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.get("/historico/:opponentPublicId", async (req, res, next) => {
    try {
      const result = await service.against({
        identity: req.radarIdentity,
        opponentPublicId: req.params.opponentPublicId,
        query: req.query,
        requestContext: { ip: clientIp(req, config) }
      });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) {
      return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    }
    logger.error?.("[RADAR_MATCH_HISTORY] request failed", {
      method: req.method,
      route: "/me/time/amistosos/historico",
      error: error?.name || "Error"
    });
    return res.status(500).json({
      ok: false,
      code: "MATCH_HISTORY_INTERNAL_ERROR",
      error: "Nao foi possivel carregar o historico."
    });
  });

  return router;
}

module.exports = { createMatchHistoryRouter };
