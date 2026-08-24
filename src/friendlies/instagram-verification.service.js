"use strict";

const crypto = require("node:crypto");
const { RadarIdentityError } = require("./radar-identity.errors");
const {
  validateInitiateInput,
  validateConfirmInput,
  validateApproveInput,
  validateRejectInput,
  validateMutationHeaders,
  verificationPublicId
} = require("./instagram-verification.schemas");
const {
  requireVerificationSecret,
  challengeForPublicId,
  challengeHash,
  payloadHash,
  scopeHash
} = require("./instagram-verification.crypto");

function workflowStatus(verification, now) {
  if (!verification) return "not_started";
  if (
    verification.status === "pending" &&
    new Date(verification.challengeExpiresAt).getTime() <= now.getTime()
  ) return "expired";
  if (verification.status === "pending" && verification.confirmationClaimedAt) {
    return "pending_review";
  }
  if (verification.status === "pending") return "challenge_issued";
  return verification.status;
}

function ownerVerification(verification, { now, maxAttempts }) {
  if (!verification) return null;
  return Object.freeze({
    verification_id: verification.publicId,
    method: verification.method,
    instagram_handle: verification.instagramHandleSnapshot,
    status: workflowStatus(verification, now),
    expires_at: verification.challengeExpiresAt,
    confirmed_at: verification.confirmationClaimedAt,
    decided_at: verification.decidedAt,
    attempts_remaining: Math.max(maxAttempts - verification.attemptCount, 0),
    version: verification.version
  });
}

function reviewItem(verification, now) {
  return Object.freeze({
    verification_id: verification.publicId,
    team_public_id: verification.teamPublicId,
    instagram_handle: verification.instagramHandleSnapshot,
    status: workflowStatus(verification, now),
    requested_at: verification.createdAt,
    confirmed_at: verification.confirmationClaimedAt,
    expires_at: verification.challengeExpiresAt,
    attempts: verification.attemptCount,
    version: verification.version
  });
}

function requestIp(requestContext) {
  return String(requestContext?.ip || requestContext?.remoteAddress || "unknown").trim() || "unknown";
}

function createInstagramVerificationService({ repository, config, now = () => new Date() }) {
  if (!repository || typeof repository.getOwnerState !== "function") {
    throw new TypeError("Instagram verification service requires a repository");
  }

  function clock() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError("now must return a valid Date");
    }
    return value;
  }

  async function rateLimit({ operation, identity, team, requestContext, secret, at }) {
    const isInitiate = operation === "initiate";
    const windowMs = config.instagramRateWindowSeconds * 1000;
    const windowStartedAt = new Date(Math.floor(at.getTime() / windowMs) * windowMs);
    const limits = isInitiate
      ? {
        account: config.instagramInitiateAccountLimit,
        team: config.instagramInitiateTeamLimit,
        ip: config.instagramInitiateIpLimit
      }
      : {
        account: config.instagramConfirmAccountLimit,
        team: config.instagramConfirmTeamLimit,
        ip: config.instagramConfirmIpLimit
      };
    const result = await repository.consumeRateLimits({
      operation,
      windowStartedAt,
      scopes: [
        { type: "account", hash: scopeHash(secret, "account", identity.accountId), limit: limits.account },
        { type: "team", hash: scopeHash(secret, "team", team.id), limit: limits.team },
        { type: "ip", hash: scopeHash(secret, "ip", requestIp(requestContext)), limit: limits.ip }
      ]
    });
    if (!result.allowed) {
      throw new RadarIdentityError(
        "VERIFICATION_RATE_LIMITED",
        429,
        "Muitas tentativas de verificacao. Tente novamente mais tarde."
      );
    }
  }

  async function getOwnerVerification(identity) {
    const at = clock();
    const state = await repository.getOwnerState(identity);
    return Object.freeze({
      instagram_handle: state.team.instagramHandle,
      instagram_verification_status: state.team.instagramVerificationStatus,
      verification: ownerVerification(state.verification, {
        now: at,
        maxAttempts: config.instagramChallengeMaxAttempts
      })
    });
  }

  async function initiate({ identity, body, idempotencyKey, requestId, requestContext }) {
    const secret = requireVerificationSecret(config);
    const input = validateInitiateInput(body);
    const headers = validateMutationHeaders({ idempotencyKey, requestId });
    const at = clock();
    const state = await repository.getOwnerState(identity);
    await rateLimit({ operation: "initiate", identity, team: state.team, requestContext, secret, at });

    const publicId = crypto.randomUUID();
    const challenge = challengeForPublicId(secret, publicId);
    const result = await repository.initiate({
      identity,
      publicId,
      instagramHandle: input.instagramHandle,
      challengeHash: challengeHash(secret, challenge.code),
      expiresAt: new Date(at.getTime() + config.instagramChallengeTtlMinutes * 60 * 1000),
      idempotencyKey: headers.idempotencyKey,
      payloadHash: payloadHash(secret, input),
      requestId: headers.requestId
    });

    const verification = result.verification;
    if (!verification) {
      throw new RadarIdentityError("VERIFICATION_NOT_FOUND", 409, "Verificacao indisponivel.");
    }
    const currentChallenge = challengeForPublicId(secret, verification.publicId);
    const canDisplayChallenge = verification.status === "pending" && !verification.confirmationClaimedAt;
    return Object.freeze({
      verification: ownerVerification(verification, {
        now: at,
        maxAttempts: config.instagramChallengeMaxAttempts
      }),
      challenge: canDisplayChallenge
        ? Object.freeze({
          segments: currentChallenge.segments,
          separator: currentChallenge.separator,
          instruction: "Una os segmentos com o separador e publique o resultado na bio do Instagram."
        })
        : null,
      replayed: result.replayed
    });
  }

  async function confirm({ identity, body, idempotencyKey, requestId, requestContext }) {
    const secret = requireVerificationSecret(config);
    const input = validateConfirmInput(body);
    const headers = validateMutationHeaders({ idempotencyKey, requestId });
    const at = clock();
    const state = await repository.getOwnerState(identity);
    await rateLimit({ operation: "confirm", identity, team: state.team, requestContext, secret, at });
    const result = await repository.confirm({
      identity,
      verificationPublicId: input.verificationId,
      submittedChallengeHash: challengeHash(secret, input.code),
      maxAttempts: config.instagramChallengeMaxAttempts,
      now: at,
      idempotencyKey: headers.idempotencyKey,
      payloadHash: payloadHash(secret, {
        verificationId: input.verificationId,
        submittedChallengeHash: challengeHash(secret, input.code)
      }),
      requestId: headers.requestId
    });

    const response = ownerVerification(result.verification, {
      now: at,
      maxAttempts: config.instagramChallengeMaxAttempts
    });
    if (result.outcome === "invalid_code") {
      throw new RadarIdentityError(
        "INVALID_VERIFICATION_CODE",
        400,
        "Codigo de verificacao invalido.",
        { attempts_remaining: response.attempts_remaining }
      );
    }
    if (result.outcome === "attempt_limit") {
      throw new RadarIdentityError(
        "VERIFICATION_ATTEMPTS_EXCEEDED",
        429,
        "Limite de tentativas atingido. Inicie uma nova verificacao."
      );
    }
    if (result.outcome === "expired") {
      throw new RadarIdentityError(
        "VERIFICATION_EXPIRED",
        410,
        "O codigo expirou. Inicie uma nova verificacao."
      );
    }
    if (result.outcome === "instagram_changed") {
      throw new RadarIdentityError(
        "INSTAGRAM_HANDLE_CHANGED",
        409,
        "O Instagram do perfil foi alterado. Inicie uma nova verificacao."
      );
    }
    if (result.outcome !== "pending_review") {
      throw new RadarIdentityError(
        "VERIFICATION_NOT_OPEN",
        409,
        "Esta verificacao nao esta aberta."
      );
    }
    return Object.freeze({ verification: response, replayed: result.replayed });
  }

  async function listPendingReviews(adminIdentity, query = {}) {
    const at = clock();
    const records = await repository.listPendingReviews(adminIdentity, {
      limit: query.limit,
      now: at
    });
    return Object.freeze({
      items: Object.freeze(records.map(record => reviewItem(record, at)))
    });
  }

  async function approve({ adminIdentity, verificationId, body, idempotencyKey, requestId }) {
    const secret = requireVerificationSecret(config);
    const publicId = verificationPublicId(verificationId);
    const input = validateApproveInput(body);
    const headers = validateMutationHeaders({ idempotencyKey, requestId });
    const observedHash = challengeHash(secret, input.observedCode);
    const at = clock();
    const result = await repository.decide({
      adminIdentity,
      verificationPublicId: publicId,
      decision: "approve",
      observedChallengeHash: observedHash,
      reason: null,
      now: at,
      idempotencyKey: headers.idempotencyKey,
      payloadHash: payloadHash(secret, { publicId, observedHash }),
      requestId: headers.requestId
    });
    if (result.outcome === "observed_code_mismatch") {
      throw new RadarIdentityError(
        "OBSERVED_CODE_MISMATCH",
        409,
        "O codigo observado na bio nao corresponde ao desafio."
      );
    }
    if (["expired", "instagram_changed"].includes(result.outcome)) {
      throw new RadarIdentityError(
        "VERIFICATION_NOT_REVIEWABLE",
        409,
        "A verificacao expirou ou deixou de corresponder ao perfil."
      );
    }
    return Object.freeze({
      verification: reviewItem(result.verification, at),
      decision: "approved",
      replayed: result.replayed
    });
  }

  async function reject({ adminIdentity, verificationId, body, idempotencyKey, requestId }) {
    const publicId = verificationPublicId(verificationId);
    const input = validateRejectInput(body);
    const headers = validateMutationHeaders({ idempotencyKey, requestId });
    const at = clock();
    const secret = requireVerificationSecret(config);
    const result = await repository.decide({
      adminIdentity,
      verificationPublicId: publicId,
      decision: "reject",
      observedChallengeHash: null,
      reason: input,
      now: at,
      idempotencyKey: headers.idempotencyKey,
      payloadHash: payloadHash(secret, { publicId, reasonCode: input.reasonCode, notes: input.notes }),
      requestId: headers.requestId
    });
    if (["expired", "instagram_changed"].includes(result.outcome)) {
      throw new RadarIdentityError(
        "VERIFICATION_NOT_REVIEWABLE",
        409,
        "A verificacao expirou ou deixou de corresponder ao perfil."
      );
    }
    return Object.freeze({
      verification: reviewItem(result.verification, at),
      decision: "rejected",
      replayed: result.replayed
    });
  }

  return Object.freeze({
    getOwnerVerification,
    initiate,
    confirm,
    listPendingReviews,
    approve,
    reject
  });
}

module.exports = {
  createInstagramVerificationService,
  ownerVerification,
  reviewItem,
  workflowStatus
};
