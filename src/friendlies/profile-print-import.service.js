"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const {
  validateProfilePrintForm,
  validateIdempotencyKey,
  normalizeProfilePrintDraft
} = require("./profile-print-import.schemas");
const {
  requireProfilePrintConfiguration,
  importPayloadHash,
  importScopeHash,
  profilePrintSafetyIdentifier
} = require("./profile-print-import.crypto");
const { ProfilePrintProviderError } = require("./profile-print-import.openai");

function sanitizeRequestId(value) {
  const requestId = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(requestId) ? requestId : null;
}

function requestIp(requestContext) {
  return String(requestContext?.ip || requestContext?.remoteAddress || "unknown").trim() || "unknown";
}

function providerFailure(error) {
  const code = error instanceof ProfilePrintProviderError
    ? error.code
    : error instanceof TypeError
      ? "schema_invalid"
      : "internal_error";
  const failures = {
    timeout: ["PROFILE_PRINT_AI_TIMEOUT", 504, "A analise demorou demais. Tente novamente."],
    refusal: ["PROFILE_PRINT_AI_REFUSED", 422, "A imagem nao pode ser analisada com seguranca."],
    incomplete: ["PROFILE_PRINT_AI_INCOMPLETE", 502, "A analise ficou incompleta. Tente novamente."],
    invalid_response: ["PROFILE_PRINT_AI_INVALID_RESPONSE", 502, "A analise retornou dados invalidos."],
    schema_invalid: ["PROFILE_PRINT_AI_INVALID_RESPONSE", 502, "A analise retornou dados invalidos."],
    rate_limited: ["PROFILE_PRINT_AI_LIMITED", 503, "O analisador esta temporariamente ocupado."],
    quota_exhausted: ["PROFILE_PRINT_AI_NOT_FUNDED", 503, "A analise por print esta temporariamente indisponivel."],
    invalid_credentials: ["PROFILE_PRINT_AI_NOT_CONFIGURED", 503, "A analise por print esta temporariamente indisponivel."],
    access_denied: ["PROFILE_PRINT_AI_ACCESS_DENIED", 503, "A analise por print esta temporariamente indisponivel."],
    request_rejected: ["PROFILE_PRINT_AI_REQUEST_REJECTED", 502, "A imagem nao pode ser analisada agora."],
    unavailable: ["PROFILE_PRINT_AI_UNAVAILABLE", 503, "O analisador esta temporariamente indisponivel."],
    cancelled: ["PROFILE_PRINT_REQUEST_CANCELLED", 499, "A importacao foi cancelada."],
    internal_error: ["PROFILE_PRINT_INTERNAL_ERROR", 500, "Nao foi possivel concluir a importacao."]
  };
  const [publicCode, status, message] = failures[code] || failures.internal_error;
  return Object.freeze({
    failureCode: code in failures ? code : "internal_error",
    error: new RadarIdentityError(publicCode, status, message)
  });
}

function createProfilePrintImportService({ repository, provider, config, now = () => new Date() }) {
  if (!repository || (
    typeof repository.getImportSubject !== "function" &&
    typeof repository.getOwnedTeam !== "function"
  )) {
    throw new TypeError("Profile print import service requires a repository");
  }
  if (!provider || typeof provider.analyze !== "function") {
    throw new TypeError("Profile print import service requires an AI provider");
  }

  function clock() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError("now must return a valid Date");
    }
    return value;
  }

  function ensureAvailable() {
    if (config?.profilePrintImportEnabled !== true) {
      throw new RadarIdentityError("PROFILE_PRINT_IMPORT_DISABLED", 404, "Recurso nao encontrado.");
    }
    return requireProfilePrintConfiguration(config);
  }

  async function authorize(identity) {
    ensureAvailable();
    return typeof repository.getImportSubject === "function"
      ? repository.getImportSubject(identity)
      : repository.getOwnedTeam(identity);
  }

  async function rateLimit({ identity, team, requestContext, at, secret }) {
    const dayStartedAt = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const monthStartedAt = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const result = await repository.consumeRateLimits({
      scopes: [
        {
          type: "account",
          hash: importScopeHash(secret, "account", identity.accountId),
          limit: config.profilePrintDailyTeamLimit,
          windowStartedAt: dayStartedAt
        },
        {
          type: "team",
          hash: importScopeHash(secret, "team", team.scopeReference),
          limit: config.profilePrintDailyTeamLimit,
          windowStartedAt: dayStartedAt
        },
        {
          type: "ip",
          hash: importScopeHash(secret, "ip", requestIp(requestContext)),
          limit: config.profilePrintIpLimit,
          windowStartedAt: dayStartedAt
        },
        {
          type: "global",
          hash: importScopeHash(secret, "global", "radar-profile-print"),
          limit: config.profilePrintMonthlyGlobalLimit,
          windowStartedAt: monthStartedAt
        }
      ]
    });
    if (!result.allowed) {
      throw new RadarIdentityError(
        "PROFILE_PRINT_RATE_LIMITED",
        429,
        "Muitas importacoes por print. Tente novamente mais tarde."
      );
    }
  }

  async function importProfilePrint({
    identity,
    fields,
    image,
    idempotencyKey,
    requestId,
    requestContext,
    signal
  }) {
    const { model, securitySecret, safetyIdentifierSecret } = ensureAvailable();
    const input = validateProfilePrintForm(fields);
    const normalizedIdempotencyKey = validateIdempotencyKey(idempotencyKey, { required: true });
    if (!image || !/^[0-9a-f]{64}$/.test(String(image.byteHash || "")) || !Buffer.isBuffer(image.buffer)) {
      throw new RadarIdentityError(
        "PROFILE_PRINT_IMAGE_INVALID",
        400,
        "A imagem nao pode ser processada."
      );
    }

    const at = clock();
    const team = typeof repository.getImportSubject === "function"
      ? await repository.getImportSubject(identity)
      : Object.freeze({ ...(await repository.getOwnedTeam(identity)), scopeReference: identity.profileId });
    const safeRequestId = sanitizeRequestId(requestId);
    const metadata = Object.freeze({
      format: image.format,
      width: image.width,
      height: image.height,
      original_size_bytes: image.originalSizeBytes,
      sanitized_size_bytes: image.sanitizedSizeBytes
    });
    const payloadHash = importPayloadHash(securitySecret, {
      evidenceHash: image.byteHash,
      instagramHandle: input.instagramHandle
    });
    const processingLeaseMs = Math.max(config.profilePrintOpenAiTimeoutMs + 30_000, 5 * 60 * 1000);
    const begun = await repository.beginImport({
      identity,
      publicId: crypto.randomUUID(),
      evidenceHash: image.byteHash,
      payloadHash,
      idempotencyKey: normalizedIdempotencyKey,
      model,
      processingExpiresAt: new Date(at.getTime() + processingLeaseMs),
      evidenceDeleteAfter: new Date(at.getTime() + config.profilePrintDraftTtlMinutes * 60 * 1000),
      metadata,
      now: at,
      requestId: safeRequestId
    });
    if (begun.kind !== "created") return begun.response;

    try {
      await rateLimit({ identity, team, requestContext, at, secret: securitySecret });
    } catch (error) {
      await repository.failImport({
        requestDbId: begun.requestDbId,
        verificationId: begun.verification.id,
        identity,
        failureCode: "rate_limited",
        now: clock(),
        requestId: safeRequestId
      });
      throw error;
    }

    try {
      const providerDraft = await provider.analyze({
        image,
        safetyIdentifier: profilePrintSafetyIdentifier(
          safetyIdentifierSecret,
          identity.accountId
        ),
        signal
      });
      const draft = normalizeProfilePrintDraft(providerDraft);
      return await repository.completeImport({
        requestDbId: begun.requestDbId,
        verificationId: begun.verification.id,
        identity,
        draft,
        metadata,
        now: clock(),
        requestId: safeRequestId
      });
    } catch (error) {
      const failure = providerFailure(error);
      await repository.failImport({
        requestDbId: begun.requestDbId,
        verificationId: begun.verification.id,
        identity,
        failureCode: failure.failureCode,
        now: clock(),
        requestId: safeRequestId
      });
      throw failure.error;
    }
  }

  return Object.freeze({ authorize, importProfilePrint });
}

module.exports = {
  createProfilePrintImportService,
  providerFailure,
  sanitizeRequestId,
  requestIp
};
