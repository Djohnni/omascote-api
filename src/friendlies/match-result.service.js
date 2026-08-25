"use strict";

const { validateIdempotencyKey } = require("./radar-identity.schemas");
const { matchError } = require("./match-center.schemas");
const {
  normalizeScore,
  validateConfirmationBody,
  resultMutationHash,
  validateMatchId,
  validateExpectedVersion
} = require("./match-result.schemas");

function clockValue(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Match result clock must return a valid Date");
  }
  return value;
}

function safeRequestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(id) ? id : null;
}

function createMatchResultService({ repository, config, clock = () => new Date() }) {
  if (!repository) throw new TypeError("Match result service requires a repository");

  function ensureAvailable() {
    if (config?.enabled !== true || config?.matchResultsEnabled !== true) {
      throw matchError("MATCH_RESULTS_DISABLED", 404, "Recurso nao encontrado.");
    }
    if (!config.matchResultsConfigured) {
      throw matchError("MATCH_RESULTS_CONFIGURATION_UNAVAILABLE", 503, "Placares temporariamente indisponiveis.");
    }
  }

  async function mutate(operation, values) {
    ensureAvailable();
    const publicId = validateMatchId(values.publicId);
    const expectedVersion = validateExpectedVersion(values.expectedVersion);
    const idempotencyKey = validateIdempotencyKey(values.idempotencyKey, { required: true });
    const value = operation === "submit_result"
      ? normalizeScore(values.body)
      : validateConfirmationBody(values.body);
    return repository.mutateOwned({
      identity: values.identity,
      publicId,
      expectedVersion,
      operation,
      value,
      idempotencyKey,
      payloadHash: resultMutationHash({ operation, publicId, expectedVersion, value }),
      now: clockValue(clock),
      requestId: safeRequestId(values.requestId)
    });
  }

  return Object.freeze({
    submit: values => mutate("submit_result", values),
    confirm: values => mutate("confirm_result", values)
  });
}

module.exports = { createMatchResultService, clockValue, safeRequestId };
