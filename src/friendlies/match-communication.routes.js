"use strict";

const express = require("express");
const { clientIp } = require("../security/client-ip");
const { isRadarIdentityError } = require("./radar-identity.errors");
const { createMatchCommunicationRepository } = require("./match-communication.repository");
const { createMatchCommunicationService } = require("./match-communication.service");

const COMMUNICATION_PATH = /^\/[0-9a-f-]{36}\/(?:comunicacao|mensagens(?:\/[0-9a-f-]{36}\/denunciar|\/lidas)?)$/i;

function createMatchCommunicationRouter({ config, auth, pool, resolveIdentity, service, logger = console }) {
  const router = express.Router();
  const parser = express.json({ limit: "8kb", strict: true });
  const communication = service || (pool
    ? createMatchCommunicationService({
        repository: createMatchCommunicationRepository({ pool, config }),
        config
      })
    : null);

  router.use((req, res, next) => COMMUNICATION_PATH.test(req.path) ? next() : next("router"));
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (config?.enabled === true && config?.matchCommunicationEnabled === true) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  router.use((req, res, next) => {
    if (typeof auth !== "function" || typeof resolveIdentity !== "function" || !communication) {
      return res.status(503).json({ ok: false, code: "RADAR_UNAVAILABLE", error: "Radar temporariamente indisponivel." });
    }
    return auth(req, res, next);
  });
  router.use(async (req, res, next) => {
    try { req.radarIdentity = await resolveIdentity(req.user); return next(); }
    catch (error) { return next(error); }
  });

  function common(req) {
    return {
      identity: req.radarIdentity,
      publicId: req.params.matchId,
      ip: clientIp(req, config),
      requestId: req.requestId || req.get("X-Request-Id"),
      idempotencyKey: req.get("Idempotency-Key")
    };
  }

  function requireJson(req, res, next) {
    return req.is("application/json") ? next() : res.status(415).json({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE", error: "Envie dados em formato JSON." });
  }

  router.get("/:matchId/comunicacao", async (req, res, next) => {
    try { return res.json({ ok: true, ...(await communication.getChannels(common(req))) }); }
    catch (error) { return next(error); }
  });

  router.get("/:matchId/mensagens", async (req, res, next) => {
    try { return res.json({ ok: true, ...(await communication.listMessages({ ...common(req), query: req.query })) }); }
    catch (error) { return next(error); }
  });

  router.post("/:matchId/mensagens", requireJson, parser, async (req, res, next) => {
    try { return res.status(201).json({ ok: true, ...(await communication.sendMessage({ ...common(req), body: req.body })) }); }
    catch (error) { return next(error); }
  });

  router.post("/:matchId/mensagens/lidas", requireJson, parser, async (req, res, next) => {
    try { return res.json({ ok: true, ...(await communication.markRead({ ...common(req), body: req.body })) }); }
    catch (error) { return next(error); }
  });

  router.post("/:matchId/mensagens/:messageId/denunciar", requireJson, parser, async (req, res, next) => {
    try {
      return res.status(201).json({ ok: true, ...(await communication.reportMessage({
        ...common(req), messagePublicId: req.params.messageId, body: req.body
      })) });
    } catch (error) { return next(error); }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) {
      return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ ok: false, code: "MATCH_MESSAGE_TOO_LARGE", error: "Mensagem muito grande." });
    }
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      return res.status(400).json({ ok: false, code: "INVALID_JSON", error: "JSON invalido." });
    }
    logger.error?.("match_communication.request_failed", {
      method: req.method, route: "/me/time/amistosos/:id/mensagens", error: error?.name || "Error"
    });
    return res.status(500).json({ ok: false, code: "MATCH_COMMUNICATION_INTERNAL_ERROR", error: "Conversa temporariamente indisponivel." });
  });

  return router;
}

module.exports = { createMatchCommunicationRouter, COMMUNICATION_PATH };
