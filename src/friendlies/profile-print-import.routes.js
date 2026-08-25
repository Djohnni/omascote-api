"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { clientIp } = require("../security/client-ip");
const { RadarIdentityError, isRadarIdentityError } = require("./radar-identity.errors");
const { validateIdempotencyKey } = require("./profile-print-import.schemas");
const { processProfilePrintImage, eraseBuffer, FORMATS } = require("./profile-print-import.image");
const { createProfilePrintOpenAiClient } = require("./profile-print-import.openai");
const { createProfilePrintImportRepository } = require("./profile-print-import.repository");
const { createProfilePrintImportService } = require("./profile-print-import.service");

function createService({ pool, config, importService, provider, fetchImpl }) {
  if (importService) return importService;
  if (!pool) return null;
  const aiProvider = provider || createProfilePrintOpenAiClient({ config, fetchImpl });
  return createProfilePrintImportService({
    repository: createProfilePrintImportRepository({ pool }),
    provider: aiProvider,
    config
  });
}

async function cleanupRequest(req) {
  if (req.profilePrintCleanupPromise) return req.profilePrintCleanupPromise;
  if (typeof req.profilePrintCleanup !== "function") return;
  const cleanup = req.profilePrintCleanup;
  req.profilePrintCleanup = null;
  req.profilePrintCleanupPromise = Promise.resolve()
    .then(cleanup)
    .catch(error => {
      req.profilePrintCleanupPromise = null;
      req.profilePrintCleanup = cleanup;
      throw error;
    });
  return req.profilePrintCleanupPromise;
}

function prepareTemporaryDirectory(req, res, next) {
  fs.mkdtemp(path.join(os.tmpdir(), "omascote-radar-profile-print-"))
    .then(directory => {
      let removed = false;
      req.profilePrintTempDirectory = directory;
      req.profilePrintCleanup = async () => {
        if (removed) return;
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        removed = true;
      };
      req.once("aborted", () => { cleanupRequest(req).catch(() => {}); });
      res.once("close", () => { cleanupRequest(req).catch(() => {}); });
      next();
    })
    .catch(next);
}

function createUploader(config) {
  const storage = multer.diskStorage({
    destination(req, file, callback) {
      callback(null, req.profilePrintTempDirectory);
    },
    filename(req, file, callback) {
      callback(null, `${crypto.randomUUID()}.upload`);
    }
  });
  return multer({
    storage,
    limits: {
      fileSize: config.profilePrintMaxFileBytes,
      files: 1,
      fields: 1,
      parts: 3,
      fieldNameSize: 80,
      fieldSize: 200
    },
    fileFilter(req, file, callback) {
      const extension = path.extname(String(file.originalname || "")).toLowerCase();
      const mime = String(file.mimetype || "").toLowerCase();
      const allowed = Object.values(FORMATS).some(
        policy => policy.mime === mime && policy.extensions.has(extension)
      );
      if (!allowed) {
        return callback(new RadarIdentityError(
          "PROFILE_PRINT_IMAGE_TYPE_INVALID",
          415,
          "Envie uma imagem PNG, JPEG ou WebP valida."
        ));
      }
      return callback(null, true);
    }
  }).single("imagem");
}

function createProfilePrintImportRouter(options) {
  const router = express.Router();
  const service = createService(options);
  const uploader = createUploader(options.config);
  const logger = options.logger || console;

  router.use((req, res, next) => {
    const handled = req.method === "POST" && req.path === "/importar-print";
    return handled ? next() : next("router");
  });
  router.use((req, res, next) => {
    if (options.config.enabled && options.config.profilePrintImportEnabled) return next();
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  });
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (typeof options.auth !== "function" || typeof options.resolveIdentity !== "function" || !service) {
      return res.status(503).json({
        ok: false,
        code: "RADAR_UNAVAILABLE",
        error: "Radar de Amistosos temporariamente indisponivel."
      });
    }
    return options.auth(req, res, next);
  });
  router.use(async (req, res, next) => {
    try {
      req.radarIdentity = await options.resolveIdentity(req.user);
      req.profilePrintIdempotencyKey = validateIdempotencyKey(
        req.get("Idempotency-Key"),
        { required: true }
      );
      await service.authorize(req.radarIdentity);
      return next();
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    "/importar-print",
    (req, res, next) => req.is("multipart/form-data")
      ? next()
      : next(new RadarIdentityError(
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "Envie o print como formulario multipart."
      )),
    prepareTemporaryDirectory,
    uploader,
    async (req, res, next) => {
      const controller = new AbortController();
      const cancelOnDisconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", cancelOnDisconnect);
      res.once("close", cancelOnDisconnect);
      let image;
      try {
        image = await processProfilePrintImage(req.file, options.config);
        const result = await service.importProfilePrint({
          identity: req.radarIdentity,
          fields: req.body,
          image,
          idempotencyKey: req.profilePrintIdempotencyKey,
          requestId: req.get("X-Request-Id"),
          requestContext: {
            ip: clientIp(req, options.config),
            remoteAddress: req.socket?.remoteAddress
          },
          signal: controller.signal
        });
        eraseBuffer(image?.buffer);
        image = null;
        await cleanupRequest(req);
        return res.status(result.replayed || result.deduplicated ? 200 : 201).json({
          ok: true,
          ...result
        });
      } catch (error) {
        return next(error);
      } finally {
        req.removeListener("aborted", cancelOnDisconnect);
        res.removeListener("close", cancelOnDisconnect);
        eraseBuffer(image?.buffer);
        await cleanupRequest(req).catch(() => {});
      }
    }
  );

  router.use(async (error, req, res, next) => {
    await cleanupRequest(req).catch(() => {});
    if (res.headersSent) return next(error);
    res.set("Cache-Control", "private, no-store");
    if (isRadarIdentityError(error)) {
      return res.status(error.status).json({
        ok: false,
        code: error.code,
        error: error.message
      });
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        ok: false,
        code: tooLarge ? "PROFILE_PRINT_IMAGE_TOO_LARGE" : "PROFILE_PRINT_MULTIPART_INVALID",
        error: tooLarge
          ? "A imagem excede o limite permitido."
          : "O formulario da imagem e invalido."
      });
    }
    logger.error?.("[RADAR_PROFILE_PRINT_IMPORT] request failed", {
      method: req.method,
      route: "/me/time/perfil/importar-print",
      error: error?.name || "Error"
    });
    return res.status(500).json({
      ok: false,
      code: "PROFILE_PRINT_INTERNAL_ERROR",
      error: "Nao foi possivel concluir a importacao."
    });
  });

  return router;
}

module.exports = {
  createProfilePrintImportRouter,
  createUploader,
  prepareTemporaryDirectory,
  cleanupRequest,
  clientIp
};
