"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRadarConfig } = require("./src/config/radar");
const { createRadarModerationService } = require("./src/friendlies/radar-moderation.service");
const {
  normalizeBlock, normalizeReport, normalizeDispute,
  normalizeExit, normalizeResolution, expectedVersion, payloadHash
} = require("./src/friendlies/radar-moderation.schemas");

const TEAM_ID = "10000000-0000-4000-8000-000000000001";
const MATCH_ID = "20000000-0000-4000-8000-000000000001";

function config(overrides = {}) {
  return createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_MODERATION_ENABLED: "true",
    RADAR_MODERATION_SECURITY_SECRET: "moderation-test-secret-at-least-32-bytes",
    ...overrides
  });
}

test("moderation feature flag remains off by default", async () => {
  const service = createRadarModerationService({ repository: {}, config: createRadarConfig({}) });
  await assert.rejects(service.listBlocks({ identity: {} }), error => error.code === "RADAR_MODERATION_DISABLED");
});

test("moderation requires an independent strong secret", async () => {
  const service = createRadarModerationService({
    repository: {},
    config: config({ RADAR_MODERATION_SECURITY_SECRET: "short" })
  });
  await assert.rejects(service.listBlocks({ identity: {} }), error => error.code === "RADAR_MODERATION_CONFIGURATION_UNAVAILABLE");
});

test("block and report contracts accept only opaque targets and structured reasons", () => {
  assert.deepEqual(normalizeBlock({ team_public_id: TEAM_ID, motivo: "safety" }), {
    teamPublicId: TEAM_ID, reason: "safety"
  });
  assert.deepEqual(normalizeReport({
    tipo: "partida", match_id: MATCH_ID, categoria: "unsafe_conduct", descricao: "  Conduta   perigosa "
  }, 500), {
    type: "partida", teamPublicId: null, matchPublicId: MATCH_ID,
    category: "unsafe_conduct", description: "Conduta perigosa"
  });
  assert.throws(() => normalizeBlock({ team_public_id: TEAM_ID, motivo: "qualquer texto" }), /opcao invalida/);
  assert.throws(() => normalizeReport({
    tipo: "time", team_public_id: TEAM_ID, categoria: "spam", reporter_team_id: TEAM_ID
  }, 500), error => error.code === "RADAR_MODERATION_OWNER_ID_FORBIDDEN");
});

test("dispute, exit and administrative decision contracts are bounded", () => {
  assert.deepEqual(normalizeDispute({ motivo: "score_incorrect" }, 500), {
    category: "score_incorrect", description: null
  });
  assert.deepEqual(normalizeExit({ confirmacao: "SAIR_DO_RADAR" }), { confirmation: "SAIR_DO_RADAR" });
  assert.deepEqual(normalizeResolution({ decisao: "invalidate_result", motivo: "invalid_result" }), {
    action: "invalidate_result", reason: "invalid_result"
  });
  assert.equal(expectedVersion('W/"3"'), 3);
  assert.throws(() => normalizeExit({ confirmacao: "sim" }), error => error.code === "RADAR_EXIT_CONFIRMATION_REQUIRED");
  assert.throws(() => normalizeResolution({ decisao: "dismiss", motivo: "invalid_result" }), /incompativel/);
});

test("moderation payload hashes are deterministic and secret-bound", () => {
  const first = payloadHash("a".repeat(32), { operation: "block", reason: "safety" });
  const repeated = payloadHash("a".repeat(32), { operation: "block", reason: "safety" });
  const otherSecret = payloadHash("b".repeat(32), { operation: "block", reason: "safety" });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, otherSecret);
  assert.equal(first.includes("safety"), false);
});
