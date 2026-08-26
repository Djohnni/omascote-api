"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { createRadarConfig, parsePilotAccountAllowlist } = require("./src/config/radar");
const { createCorsOriginAllowlist } = require("./src/config/cors");
const { createPool, checkDatabase } = require("./src/db/pool");
const { migrate } = require("./src/db/migrate");
const { createPilotGatedRadarIdentityResolver } = require("./src/friendlies/radar-identity.policy");
const { createProfilePrintImportRouter } = require("./src/friendlies/profile-print-import.routes");

async function request(app, route, options = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}${route}`, options);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("legacy allowlist input is normalized but no longer gates active accounts", () => {
  assert.deepEqual(parsePilotAccountAllowlist(" account-alpha,account-beta,account-alpha, telefone +55 "), [
    "account-alpha", "account-beta"
  ]);
  const config = createRadarConfig({ RADAR_PILOT_ACCOUNT_ALLOWLIST: "account-alpha,account-beta" });
  const resolver = createPilotGatedRadarIdentityResolver({
    config,
    resolveIdentity: user => ({ accountId: user.accountId, profileId: "profile-local" })
  });
  assert.equal(resolver({ accountId: "account-alpha" }).accountId, "account-alpha");
  assert.equal(resolver({ accountId: "account-outside" }).accountId, "account-outside");
  const openPilot = createPilotGatedRadarIdentityResolver({
    config: createRadarConfig({}),
    resolveIdentity: user => user
  });
  assert.equal(openPilot({ accountId: "any-account" }).accountId, "any-account");
});

test("local CORS origins are explicit additions and never replace production origins", () => {
  assert.deepEqual(createCorsOriginAllowlist({ OMASCOTE_CORS_ORIGINS: "http://127.0.0.1:4190, javascript:alert(1),http://127.0.0.1:4190/path" }), [
    "https://omascote.com.br",
    "https://www.omascote.com.br",
    "http://127.0.0.1:4190"
  ]);
});

test("disabled print import never intercepts the existing private team profile", async () => {
  const config = createRadarConfig({});
  const app = express();
  app.use("/me/time/perfil", createProfilePrintImportRouter({ config }));
  app.get("/me/time/perfil", (req, res) => res.json({ ok: true, legacy_profile: true }));
  const profile = await request(app, "/me/time/perfil");
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), { ok: true, legacy_profile: true });
  const disabledImport = await request(app, "/me/time/perfil/importar-print", { method: "POST" });
  assert.equal(disabledImport.status, 404);
});

test("embedded local PostgreSQL runs migrations twice and is unavailable in production mode", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radar-local-pg-"));
  const config = createRadarConfig({ RADAR_DATABASE_EMBEDDED_PATH: directory });
  const pool = createPool(config);
  try {
    const first = await migrate({ pool });
    const second = await migrate({ pool });
    assert.equal(first.at(-1), "015_radar_automatic_participation.sql");
    assert.deepEqual(second, []);
    assert.deepEqual(await checkDatabase(pool), { ok: true });
  } finally {
    await pool.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const production = createRadarConfig({ NODE_ENV: "production", RADAR_DATABASE_EMBEDDED_PATH: directory });
  assert.equal(createPool(production), null);
});
