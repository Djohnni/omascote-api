"use strict";

const { validateIdempotencyKey } = require("./radar-identity.schemas");
const {
  invitationError,
  normalizeCreateInvitation,
  normalizeCounterProposal,
  validateInvitationWindow,
  validatePublicId,
  validateExpectedVersion,
  validateEmptyBody,
  validateInvitationList,
  validateNotificationList,
  invitationMutationHash
} = require("./invitation.schemas");
const { encodeNotificationCursor, decodeNotificationCursor } = require("./invitation.crypto");

function clockValue(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Invitation clock must return a valid Date");
  return value;
}

function requestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(id) ? id : null;
}

function createInvitationService({ repository, config, clock = () => new Date() }) {
  if (!repository) throw new TypeError("Invitation service requires a repository");

  function ensureAvailable() {
    if (config?.enabled !== true || config?.invitationsEnabled !== true) {
      throw invitationError("INVITATIONS_DISABLED", 404, "Recurso nao encontrado.");
    }
    if (!config.invitationsConfigured) {
      throw invitationError("INVITATIONS_CONFIGURATION_UNAVAILABLE", 503, "Convites temporariamente indisponiveis.");
    }
  }

  async function create({ identity, body, idempotencyKey, ip, requestId: rawRequestId }) {
    ensureAvailable();
    const value = normalizeCreateInvitation(body);
    const now = clockValue(clock);
    validateInvitationWindow(value, { now, maxHorizonDays: config.invitationMaxHorizonDays });
    const key = validateIdempotencyKey(idempotencyKey);
    return repository.createOwned({
      identity, value, idempotencyKey: key,
      payloadHash: invitationMutationHash({ operation: "create", value }),
      now, ip, requestId: requestId(rawRequestId)
    });
  }

  async function list({ identity, query, ip }) {
    ensureAvailable();
    const { box, limit } = validateInvitationList(query, config);
    return repository.listOwned({ identity, box, limit, now: clockValue(clock), ip });
  }

  async function mutate(operation, { identity, publicId, body, expectedVersion, idempotencyKey, ip, requestId: rawRequestId }) {
    ensureAvailable();
    const id = validatePublicId(publicId, "id");
    const version = validateExpectedVersion(expectedVersion);
    const key = validateIdempotencyKey(idempotencyKey);
    const value = operation === "counter" ? normalizeCounterProposal(body) : validateEmptyBody(body);
    const now = clockValue(clock);
    if (operation === "counter") validateInvitationWindow(value, { now, maxHorizonDays: config.invitationMaxHorizonDays });
    return repository.mutateOwned({
      identity, publicId: id, expectedVersion: version, operation, value,
      idempotencyKey: key,
      payloadHash: invitationMutationHash({ operation, publicId: id, expectedVersion: version, value }),
      now, ip, requestId: requestId(rawRequestId)
    });
  }

  async function listNotifications({ identity, query, ip }) {
    ensureAvailable();
    const { cursor, limit } = validateNotificationList(
      query,
      config,
      value => decodeNotificationCursor(config, value)
    );
    const result = await repository.listNotifications({ identity, cursor, limit, now: clockValue(clock), ip });
    const hasMore = result.rows.length > result.limit;
    const items = result.rows.slice(0, result.limit);
    const last = items.at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      pagination: Object.freeze({
        has_more: hasMore,
        next_cursor: hasMore && last
          ? encodeNotificationCursor(config, { created_at: last.created_at, public_id: last.notification_id })
          : null
      })
    });
  }

  async function readNotification({ identity, publicId, body, idempotencyKey, ip }) {
    ensureAvailable();
    validateEmptyBody(body);
    const id = validatePublicId(publicId, "id");
    const key = validateIdempotencyKey(idempotencyKey);
    return repository.readNotification({
      identity, publicId: id, idempotencyKey: key,
      payloadHash: invitationMutationHash({ operation: "notification_read", publicId: id }),
      now: clockValue(clock), ip
    });
  }

  return Object.freeze({
    create,
    list,
    accept: values => mutate("accept", values),
    decline: values => mutate("decline", values),
    cancel: values => mutate("cancel", values),
    counter: values => mutate("counter", values),
    listNotifications,
    readNotification
  });
}

module.exports = { createInvitationService, clockValue, requestId };
