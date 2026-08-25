"use strict";

const express = require("express");
const { clientIp } = require("../security/client-ip");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { createInvitationRepository } = require("./invitation.repository");
const { createInvitationService } = require("./invitation.service");

function setInvitationEtag(res, result) {
  const version = result?.invitation?.version;
  if (Number.isInteger(version) && version > 0) res.set("ETag", `W/\"${version}\"`);
}

function createInvitationRouters({ config, auth, pool, resolveIdentity, invitationService, logger = console }) {
  const service = invitationService || (pool
    ? createInvitationService({ repository: createInvitationRepository({ pool, config }), config })
    : null);
  const invitationRouter = express.Router();
  const teamRouter = express.Router();
  const notificationRouter = express.Router();
  const parser = express.json({ limit: "16kb", strict: true });

  function base(router) {
    router.use((req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      if (config?.enabled === true && config?.invitationsEnabled === true) return next();
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
  }

  function requireJson(req, res, next) {
    return req.is("application/json")
      ? next()
      : next(new RadarIdentityError("UNSUPPORTED_MEDIA_TYPE", 415, "Envie dados em formato JSON."));
  }

  function context(req) {
    return {
      identity: req.radarIdentity,
      body: req.body,
      idempotencyKey: req.get("Idempotency-Key"),
      expectedVersion: req.get("If-Match"),
      ip: clientIp(req, config),
      requestId: req.get("X-Request-Id")
    };
  }

  base(invitationRouter);
  base(teamRouter);
  base(notificationRouter);

  invitationRouter.post("/convites", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.create(context(req));
      setInvitationEtag(res, result);
      return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  for (const [route, method] of [
    ["aceitar", "accept"], ["recusar", "decline"], ["cancelar", "cancel"], ["contrapropor", "counter"]
  ]) {
    invitationRouter.post(`/convites/:id/${route}`, requireJson, parser, async (req, res, next) => {
      try {
        const result = await service[method]({ ...context(req), publicId: req.params.id });
        setInvitationEtag(res, result);
        return res.json({ ok: true, ...result });
      } catch (error) { return next(error); }
    });
  }

  teamRouter.get("/convites", async (req, res, next) => {
    try {
      const result = await service.list({ identity: req.radarIdentity, query: req.query, ip: clientIp(req, config) });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  notificationRouter.get("/", async (req, res, next) => {
    try {
      const result = await service.listNotifications({ identity: req.radarIdentity, query: req.query, ip: clientIp(req, config) });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  notificationRouter.post("/:id/lida", requireJson, parser, async (req, res, next) => {
    try {
      const result = await service.readNotification({ ...context(req), publicId: req.params.id });
      return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
  });

  function errors(router, route) {
    router.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      res.set("Cache-Control", "private, no-store");
      if (isRadarIdentityError(error)) {
        return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
      }
      if (error?.type === "entity.too.large") {
        return res.status(413).json({ ok: false, code: "INVITATION_PAYLOAD_TOO_LARGE", error: "Dados muito grandes." });
      }
      if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
        return res.status(400).json({ ok: false, code: "INVALID_JSON", error: "JSON invalido." });
      }
      logger.error?.("[RADAR_INVITATIONS] request failed", { method: req.method, route, error: error?.name || "Error" });
      return res.status(500).json({ ok: false, code: "INVITATION_INTERNAL_ERROR", error: "Nao foi possivel processar a solicitacao." });
    });
  }

  errors(invitationRouter, "/amistosos/convites");
  errors(teamRouter, "/me/time/amistosos/convites");
  errors(notificationRouter, "/me/notificacoes");
  return Object.freeze({ invitationRouter, teamRouter, notificationRouter });
}

module.exports = { createInvitationRouters, clientIp, setInvitationEtag };
