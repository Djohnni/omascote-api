"use strict";

const express = require("express");
const { clientIp } = require("../security/client-ip");
const { isRadarIdentityError } = require("./radar-identity.errors");
const { createFriendlySearchRepository } = require("./friendly-search.repository");
const { createFriendlySearchService } = require("./friendly-search.service");

function createFriendlySearchRouter({
  config,
  auth,
  pool,
  resolveIdentity,
  resolvePublicProfile,
  resolvePublicProfiles,
  searchService,
  logger = console
}) {
  const router = express.Router();
  const hasPublicResolver = typeof resolvePublicProfile === "function" ||
    typeof resolvePublicProfiles === "function";
  const service = searchService || (pool && hasPublicResolver
    ? createFriendlySearchService({
      repository: createFriendlySearchRepository({ pool, config }),
      config,
      resolvePublicProfile,
      resolvePublicProfiles
    })
    : null);

  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (config?.enabled === true && config?.searchEnabled === true) return next();
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

  router.get("/times-proximos", async (req, res, next) => {
    try {
      const result = await service.search({
        identity: req.radarIdentity,
        query: req.query,
        requestContext: { ip: clientIp(req, config) }
      });
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
    logger.error?.("[RADAR_FRIENDLY_SEARCH] request failed", {
      method: req.method,
      route: "/amistosos/times-proximos",
      error: error?.name || "Error"
    });
    return res.status(500).json({
      ok: false,
      code: "FRIENDLY_SEARCH_INTERNAL_ERROR",
      error: "Nao foi possivel procurar times agora."
    });
  });

  return router;
}

module.exports = { createFriendlySearchRouter, clientIp };
