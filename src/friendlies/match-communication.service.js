"use strict";

const {
  error,
  uuid,
  normalizeMessage,
  normalizeRead,
  normalizeReport,
  normalizeList,
  validateMutationKey,
  requestId
} = require("./match-communication.schemas");
const { decodeCursor, payloadHash } = require("./match-communication.crypto");

function validClock(clock) {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Invalid match communication clock");
  return now;
}

function createMatchCommunicationService({ repository, config, clock = () => new Date() }) {
  if (!repository) throw new TypeError("Match communication service requires a repository");

  function ensureAvailable() {
    if (config?.enabled !== true || config?.matchCommunicationEnabled !== true) {
      throw error("MATCH_COMMUNICATION_DISABLED", 404, "Recurso nao encontrado.");
    }
    if (!config.matchCommunicationConfigured || !config.matchCommunicationSecuritySecret) {
      throw error("MATCH_COMMUNICATION_CONFIGURATION_UNAVAILABLE", 503, "Conversa temporariamente indisponivel.");
    }
  }

  function base(values) {
    ensureAvailable();
    return {
      identity: values.identity,
      publicId: uuid(values.publicId),
      ip: values.ip || "unknown",
      now: validClock(clock)
    };
  }

  function mutation(operation, values, normalized, messagePublicId = null) {
    const current = base(values);
    const idempotencyKey = validateMutationKey(values.idempotencyKey);
    const fingerprint = {
      operation,
      match_id: current.publicId,
      ...(messagePublicId ? { message_id: messagePublicId } : {}),
      value: normalized
    };
    return {
      ...current,
      operation,
      value: normalized,
      messagePublicId,
      idempotencyKey,
      payloadHash: payloadHash(config, fingerprint),
      requestId: requestId(values.requestId)
    };
  }

  return Object.freeze({
    getChannels(values) {
      return repository.getChannels(base(values));
    },
    listMessages(values) {
      const current = base(values);
      const list = normalizeList(values.query, config);
      return repository.listMessages({
        ...current,
        cursor: decodeCursor(config, list.cursor),
        limit: list.limit
      });
    },
    sendMessage(values) {
      const normalized = normalizeMessage(values.body);
      return repository.sendMessage(mutation("send_message", values, normalized));
    },
    markRead(values) {
      const normalized = normalizeRead(values.body);
      return repository.markRead(mutation("mark_read", values, normalized));
    },
    reportMessage(values) {
      const messagePublicId = uuid(values.messagePublicId, "MATCH_MESSAGE_NOT_FOUND");
      const normalized = normalizeReport(values.body);
      return repository.reportMessage(mutation("report_message", values, normalized, messagePublicId));
    }
  });
}

module.exports = { createMatchCommunicationService, validClock };
