"use strict";

const express = require("express");
const { clientIp } = require("../security/client-ip");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const {
  createInstagramVerificationRepository
} = require("./instagram-verification.repository");
const {
  createInstagramVerificationService
} = require("./instagram-verification.service");

function createService({ pool, config, verificationService }) {
  return verificationService || (pool
    ? createInstagramVerificationService({
      repository: createInstagramVerificationRepository({ pool }),
      config
    })
    : null);
}

function installCommonMiddleware(router, {
  config,
  auth,
  resolveIdentity,
  service
}) {
  router.use((req, res, next) => {
    if (res.locals.skipInstagramVerificationRouter) return next();
    if (config.enabled) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  router.use((req, res, next) => {
    if (res.locals.skipInstagramVerificationRouter) return next();
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
    if (res.locals.skipInstagramVerificationRouter) return next();
    try {
      req.radarIdentity = await resolveIdentity(req.user);
      return next();
    } catch (error) {
      return next(error);
    }
  });
}

function jsonMutation(parser) {
  return [
    (req, res, next) => req.is("application/json")
      ? next()
      : next(new RadarIdentityError(
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "Envie os dados da verificacao em formato JSON."
      )),
    parser
  ];
}

function rateLimitIp(req, config) {
  return clientIp(req, config);
}

function requestArguments(req, config) {
  return {
    body: req.body,
    idempotencyKey: req.get("Idempotency-Key"),
    requestId: req.get("X-Request-Id"),
    requestContext: {
      ip: rateLimitIp(req, config),
      remoteAddress: req.socket?.remoteAddress
    }
  };
}

function installErrorHandler(router, logger) {
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) {
      const body = { ok: false, code: error.code, error: error.message };
      if (Number.isInteger(error.details?.attempts_remaining)) {
        body.attempts_remaining = error.details.attempts_remaining;
      }
      return res.status(error.status).json(body);
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        ok: false,
        code: "VERIFICATION_PAYLOAD_TOO_LARGE",
        error: "Dados da verificacao muito grandes."
      });
    }
    if (error instanceof SyntaxError && error?.type === "entity.parse.failed") {
      return res.status(400).json({
        ok: false,
        code: "INVALID_JSON",
        error: "Dados da verificacao invalidos."
      });
    }
    logger.error?.("[RADAR_INSTAGRAM_VERIFICATION] request failed", {
      method: req.method,
      path: req.originalUrl,
      error: error?.name || "Error"
    });
    return res.status(500).json({
      ok: false,
      code: "VERIFICATION_INTERNAL_ERROR",
      error: "Nao foi possivel processar a verificacao."
    });
  });
}

function createInstagramVerificationRouter(options) {
  const router = express.Router();
  const parser = express.json({ limit: "8kb", strict: true });
  const service = createService(options);
  router.use((req, res, next) => {
    const handled = (
      (req.method === "GET" && req.path === "/verificacao") ||
      (req.method === "POST" && [
        "/verificacoes/instagram",
        "/verificacoes/instagram/confirmar"
      ].includes(req.path))
    );
    const reservedRadarPath = (
      req.path === "/perfil/importar-print" ||
      req.path === "/radar" ||
      req.path.startsWith("/radar/") ||
      req.path === "/amistosos" ||
      req.path.startsWith("/amistosos/")
    );
    if (!handled && !reservedRadarPath) {
      res.locals.skipInstagramVerificationRouter = true;
    }
    return next();
  });
  installCommonMiddleware(router, { ...options, service });

  router.get("/verificacao", async (req, res, next) => {
    try {
      const result = await service.getOwnerVerification(req.radarIdentity);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/verificacoes/instagram", ...jsonMutation(parser), async (req, res, next) => {
    try {
      const result = await service.initiate({
        identity: req.radarIdentity,
        ...requestArguments(req, options.config)
      });
      return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    "/verificacoes/instagram/confirmar",
    ...jsonMutation(parser),
    async (req, res, next) => {
      try {
        const result = await service.confirm({
          identity: req.radarIdentity,
          ...requestArguments(req, options.config)
        });
        return res.json({ ok: true, ...result });
      } catch (error) {
        return next(error);
      }
    }
  );

  installErrorHandler(router, options.logger || console);
  return router;
}

function createInstagramVerificationAdminRouter(options) {
  const router = express.Router();
  const parser = express.json({ limit: "8kb", strict: true });
  const service = createService(options);
  installCommonMiddleware(router, { ...options, service });

  router.get("/", async (req, res, next) => {
    try {
      const result = await service.listPendingReviews(req.radarIdentity, req.query);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:verificationId/aprovar", ...jsonMutation(parser), async (req, res, next) => {
    try {
      const result = await service.approve({
        adminIdentity: req.radarIdentity,
        verificationId: req.params.verificationId,
        ...requestArguments(req, options.config)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:verificationId/rejeitar", ...jsonMutation(parser), async (req, res, next) => {
    try {
      const result = await service.reject({
        adminIdentity: req.radarIdentity,
        verificationId: req.params.verificationId,
        ...requestArguments(req, options.config)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  installErrorHandler(router, options.logger || console);
  return router;
}

module.exports = {
  createInstagramVerificationRouter,
  createInstagramVerificationAdminRouter,
  rateLimitIp
};
