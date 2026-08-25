"use strict";

const { validateIdempotencyKey } = require("./radar-identity.schemas");
const {
  normalizeReview,
  reputationError,
  reviewPayloadHash,
  validateMatchId,
  validateTeamPublicId
} = require("./team-reputation.schemas");

function validClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Team reputation clock must return a valid Date");
  }
  return value;
}

function safeRequestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(id) ? id : null;
}

function createTeamReputationService({ repository, config, clock = () => new Date() }) {
  if (!repository) throw new TypeError("Team reputation service requires a repository");

  function ensureAvailable() {
    if (config?.enabled !== true || config?.reputationEnabled !== true) {
      throw reputationError("TEAM_REPUTATION_DISABLED", 404, "Recurso nao encontrado.");
    }
    if (!config.reputationConfigured) {
      throw reputationError("TEAM_REPUTATION_CONFIGURATION_UNAVAILABLE", 503, "Avaliacoes temporariamente indisponiveis.");
    }
  }

  async function pending({ identity }) {
    ensureAvailable();
    return repository.listPending({ identity });
  }

  async function submit(values) {
    ensureAvailable();
    const publicId = validateMatchId(values.publicId);
    const idempotencyKey = validateIdempotencyKey(values.idempotencyKey, { required: true });
    const review = normalizeReview(values.body);
    return repository.submit({
      identity: values.identity,
      publicId,
      review,
      idempotencyKey,
      payloadHash: reviewPayloadHash(config.reputationSecuritySecret, {
        operation: "submit_review", publicId, review
      }),
      now: validClock(clock),
      requestId: safeRequestId(values.requestId)
    });
  }

  async function own({ identity }) {
    ensureAvailable();
    return repository.getOwn({
      identity,
      minimum: config.reputationMinimumVerifiedReviews
    });
  }

  async function publicReputation({ teamPublicId }) {
    ensureAvailable();
    return repository.getPublic({
      teamPublicId: validateTeamPublicId(teamPublicId),
      minimum: config.reputationMinimumVerifiedReviews
    });
  }

  return Object.freeze({ pending, submit, own, publicReputation });
}

module.exports = { createTeamReputationService, validClock, safeRequestId };
