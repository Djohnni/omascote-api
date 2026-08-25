"use strict";

const {
  moderationError, publicId, normalizeBlock, normalizeReport, normalizeDispute,
  normalizeExit, normalizeAssign, normalizeResolution, expectedVersion,
  mutationKey, payloadHash, scopeHash
} = require("./radar-moderation.schemas");

function createRadarModerationService({ repository, config, clock = () => new Date() }) {
  if (!repository) throw new TypeError("Radar moderation service requires a repository");

  function ready() {
    if (config?.enabled !== true || config?.moderationEnabled !== true) {
      throw moderationError("RADAR_MODERATION_DISABLED", 404, "Recurso nao encontrado.");
    }
    if (!config.moderationConfigured) {
      throw moderationError("RADAR_MODERATION_CONFIGURATION_UNAVAILABLE", 503, "Seguranca temporariamente indisponivel.");
    }
  }

  function now() {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Invalid moderation clock");
    return value;
  }

  function mutation(operation, input, normalized) {
    const key = mutationKey(input.idempotencyKey);
    return {
      identity: input.identity,
      value: normalized,
      operation,
      idempotencyKey: key,
      payloadHash: payloadHash(config.moderationSecuritySecret, { operation, ...normalized }),
      now: now(),
      requestId: /^[A-Za-z0-9._:-]{1,120}$/.test(String(input.requestId || "")) ? input.requestId : null,
      ipHash: scopeHash(config.moderationSecuritySecret, "ip", input.ip),
      accountHash: scopeHash(config.moderationSecuritySecret, "account", input.identity.accountId)
    };
  }

  async function listBlocks({ identity }) { ready(); return repository.listBlocks({ identity }); }
  async function block(input) { ready(); return repository.block(mutation("block", input, normalizeBlock(input.body))); }
  async function unblock(input) {
    ready();
    const value = { teamPublicId: publicId(input.teamPublicId, "teamPublicId") };
    return repository.unblock(mutation("unblock", input, value));
  }
  async function report(input) {
    ready();
    return repository.createCase(mutation("report", input, normalizeReport(input.body, config.moderationDescriptionMaximum)));
  }
  async function listCases({ identity }) { ready(); return repository.listOwnerCases({ identity, now: now() }); }
  async function dispute(input) {
    ready();
    const value = {
      matchPublicId: publicId(input.matchPublicId, "matchId"),
      ...normalizeDispute(input.body, config.moderationDescriptionMaximum)
    };
    return repository.createCase(mutation("dispute", input, value));
  }
  async function exitRadar(input) { ready(); return repository.exitRadar(mutation("radar_exit", input, normalizeExit(input.body))); }
  async function adminQueue({ identity, query }) {
    ready();
    const limit = Math.min(Math.max(Number(query?.limit) || config.moderationPageDefault, 1), config.moderationPageMaximum);
    return repository.adminQueue({ identity, limit, now: now() });
  }
  async function assign(input) {
    ready();
    const value = {
      casePublicId: publicId(input.casePublicId, "caseId"),
      expectedVersion: expectedVersion(input.ifMatch),
      ...normalizeAssign(input.body)
    };
    return repository.assignCase(mutation("assign_case", input, value));
  }
  async function resolve(input) {
    ready();
    const value = {
      casePublicId: publicId(input.casePublicId, "caseId"),
      expectedVersion: expectedVersion(input.ifMatch),
      ...normalizeResolution(input.body)
    };
    return repository.resolveCase(mutation("resolve_case", input, value));
  }

  return Object.freeze({ listBlocks, block, unblock, report, listCases, dispute, exitRadar, adminQueue, assign, resolve });
}

module.exports = { createRadarModerationService };
