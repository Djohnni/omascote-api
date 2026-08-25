"use strict";

const express = require("express");
const { isRadarIdentityError } = require("./radar-identity.errors");
const { createRadarModerationRepository } = require("./radar-moderation.repository");
const { createRadarModerationService } = require("./radar-moderation.service");
const { rateLimitIp } = require("./instagram-verification.routes");

function createService(options) {
  return options.moderationService || (options.pool
    ? createRadarModerationService({
      repository: createRadarModerationRepository({ pool: options.pool, config: options.config }),
      config: options.config
    }) : null);
}

function common(router, options, service) {
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (options.config?.enabled !== true || options.config?.moderationEnabled !== true) {
      return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
    }
    if (!service || typeof options.auth !== "function" || typeof options.resolveIdentity !== "function") {
      return res.status(503).json({ ok: false, code: "RADAR_UNAVAILABLE", error: "Radar temporariamente indisponivel." });
    }
    return options.auth(req, res, next);
  });
  router.use(async (req, res, next) => {
    try { req.radarIdentity = await options.resolveIdentity(req.user); return next(); }
    catch (error) { return next(error); }
  });
}

function json(parser) {
  return [(req, res, next) => req.is("application/json")
    ? next()
    : res.status(415).json({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE", error: "Envie dados em JSON." }), parser];
}

function args(req, config) {
  return {
    identity: req.radarIdentity,
    body: req.body,
    idempotencyKey: req.get("Idempotency-Key"),
    requestId: req.get("X-Request-Id"),
    ip: rateLimitIp(req, config)
  };
}

function errors(router, logger) {
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) {
      return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    }
    if (error?.type === "entity.too.large") return res.status(413).json({ ok: false, code: "RADAR_MODERATION_PAYLOAD_TOO_LARGE", error: "Dados muito grandes." });
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") return res.status(400).json({ ok: false, code: "INVALID_JSON", error: "Dados invalidos." });
    logger.error?.("[RADAR_MODERATION] request failed", { method: req.method, path: req.originalUrl, error: error?.name || "Error" });
    return res.status(500).json({ ok: false, code: "RADAR_MODERATION_INTERNAL_ERROR", error: "Nao foi possivel concluir a operacao." });
  });
}

function createRadarModerationRouters(options) {
  const ownerRouter = express.Router();
  const matchRouter = express.Router();
  const adminRouter = express.Router();
  const parser = express.json({ limit: "4kb", strict: true });
  const service = createService(options);
  for (const router of [ownerRouter, matchRouter, adminRouter]) common(router, options, service);

  ownerRouter.get("/bloqueios", async (req, res, next) => {
    try { return res.json({ ok: true, ...(await service.listBlocks({ identity: req.radarIdentity })) }); }
    catch (error) { return next(error); }
  });
  ownerRouter.post("/bloqueios", ...json(parser), async (req, res, next) => {
    try {
      const result = await service.block(args(req, options.config));
      return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });
  ownerRouter.delete("/bloqueios/:teamPublicId", async (req, res, next) => {
    try {
      const result = await service.unblock({ ...args(req, options.config), teamPublicId: req.params.teamPublicId });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });
  ownerRouter.post("/denuncias", ...json(parser), async (req, res, next) => {
    try {
      const result = await service.report(args(req, options.config));
      return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });
  ownerRouter.get("/denuncias", async (req, res, next) => {
    try { return res.json({ ok: true, ...(await service.listCases({ identity: req.radarIdentity })) }); }
    catch (error) { return next(error); }
  });
  ownerRouter.post("/exclusao", ...json(parser), async (req, res, next) => {
    try { return res.json({ ok: true, ...(await service.exitRadar(args(req, options.config))) }); }
    catch (error) { return next(error); }
  });

  matchRouter.post("/:matchId/contestacao", ...json(parser), async (req, res, next) => {
    try {
      const result = await service.dispute({ ...args(req, options.config), matchPublicId: req.params.matchId });
      return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  adminRouter.get("/", async (req, res, next) => {
    try { return res.json({ ok: true, ...(await service.adminQueue({ identity: req.radarIdentity, query: req.query })) }); }
    catch (error) { return next(error); }
  });
  adminRouter.post("/:caseId/atribuir", ...json(parser), async (req, res, next) => {
    try {
      const result = await service.assign({
        ...args(req, options.config), casePublicId: req.params.caseId, ifMatch: req.get("If-Match")
      });
      res.set("ETag", `W/\"${result.case.version}\"`);
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });
  adminRouter.post("/:caseId/resolver", ...json(parser), async (req, res, next) => {
    try {
      const result = await service.resolve({
        ...args(req, options.config), casePublicId: req.params.caseId, ifMatch: req.get("If-Match")
      });
      res.set("ETag", `W/\"${result.case.version}\"`);
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  errors(ownerRouter, options.logger || console);
  errors(matchRouter, options.logger || console);
  errors(adminRouter, options.logger || console);
  return Object.freeze({ ownerRouter, matchRouter, adminRouter });
}

module.exports = { createRadarModerationRouters };
