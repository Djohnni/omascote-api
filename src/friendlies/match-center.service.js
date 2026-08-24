"use strict";

const { validateIdempotencyKey } = require("./radar-identity.schemas");
const {
  matchError,
  validateMatchId,
  validateExpectedVersion,
  validateEmptyBody,
  normalizeCancellation,
  validateMatchList,
  mutationHash,
  safeResolvedContact
} = require("./match-center.schemas");

function clockValue(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Match center clock must return a valid Date");
  }
  return value;
}

function requestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(id) ? id : null;
}

function createMatchCenterService({ repository, config, resolveContact, clock = () => new Date() }) {
  if (!repository) throw new TypeError("Match center service requires a repository");

  function ensureAvailable() {
    if (config?.enabled !== true || config?.matchCenterEnabled !== true) {
      throw matchError("MATCH_CENTER_DISABLED", 404, "Recurso nao encontrado.");
    }
    if (!config.matchCenterConfigured) {
      throw matchError("MATCH_CENTER_CONFIGURATION_UNAVAILABLE", 503, "Central temporariamente indisponivel.");
    }
  }

  async function list({ identity, query }) {
    ensureAvailable();
    const { state, limit } = validateMatchList(query, config);
    return repository.listOwned({ identity, state, limit });
  }

  async function get({ identity, publicId }) {
    ensureAvailable();
    const id = validateMatchId(publicId);
    const result = await repository.getOwned({ identity, publicId: id });
    let opponentContact = null;
    if (typeof resolveContact === "function" && result.opponentAccountReference) {
      opponentContact = safeResolvedContact(
        await resolveContact(result.opponentAccountReference)
      );
    }
    return Object.freeze({
      match: Object.freeze({
        ...result.match,
        opponent_contact: opponentContact
      })
    });
  }

  async function mutate(operation, { identity, publicId, body, expectedVersion, idempotencyKey, requestId: rawRequestId }) {
    ensureAvailable();
    const id = validateMatchId(publicId);
    const version = validateExpectedVersion(expectedVersion);
    const key = validateIdempotencyKey(idempotencyKey, { required: true });
    const value = operation === "cancel" ? normalizeCancellation(body) : validateEmptyBody(body);
    return repository.mutateOwned({
      identity,
      publicId: id,
      expectedVersion: version,
      operation,
      value,
      idempotencyKey: key,
      payloadHash: mutationHash({ operation, publicId: id, expectedVersion: version, value }),
      now: clockValue(clock),
      requestId: requestId(rawRequestId)
    });
  }

  return Object.freeze({
    list,
    get,
    confirmOccurrence: values => mutate("confirm_occurrence", values),
    cancel: values => mutate("cancel", values)
  });
}

module.exports = { createMatchCenterService, clockValue, requestId };
