"use strict";

const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { createRadarConfig } = require("../src/config/radar");
const { createPool } = require("../src/db/pool");
const { migrate } = require("../src/db/migrate");

const accounts = Object.freeze([
  {
    login: "radar_alpha",
    accountReference: "account-radar-alpha-local",
    profileId: "pf_radar_alpha_local",
    name: "Estrela Norte FC",
    slug: "estrela-norte-local",
    instagram: "estrelanortelocal",
    city: "Joinville",
    state: "SC",
    cityCode: "4209102",
    latitude: -26.304500,
    longitude: -48.848700,
    email: "alpha@radar.local.invalid"
  },
  {
    login: "radar_beta",
    accountReference: "account-radar-beta-local",
    profileId: "pf_radar_beta_local",
    name: "União da Vila FC",
    slug: "uniao-vila-local",
    instagram: "uniaovilalocal",
    city: "Joinville",
    state: "SC",
    cityCode: "4209102",
    latitude: -26.314500,
    longitude: -48.858700,
    email: "beta@radar.local.invalid"
  },
  {
    login: "radar_moderador",
    accountReference: "account-radar-moderator-local",
    profileId: "pf_radar_moderator_local",
    name: "Moderação Radar Local",
    slug: "moderacao-radar-local",
    instagram: "moderacaoradarlocal",
    city: "Joinville",
    state: "SC",
    cityCode: "4209102",
    latitude: -26.294500,
    longitude: -48.838700,
    email: "moderador@radar.local.invalid",
    moderator: true
  },
  {
    login: "radar_fora",
    accountReference: "account-radar-outside-local",
    profileId: "pf_radar_outside_local",
    name: "Conta Fora do Piloto",
    slug: "fora-piloto-local",
    instagram: "forapilotolocal",
    city: "Joinville",
    state: "SC",
    cityCode: "4209102",
    latitude: -26.324500,
    longitude: -48.868700,
    email: "fora@radar.local.invalid",
    pilot: false
  }
]);

function stagingLoadAccounts(total) {
  return Array.from({ length: total }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const opaqueSuffix = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    return Object.freeze({
      login: `load_team_${number}`,
      accountReference: `account-radar-load-${opaqueSuffix}`,
      profileId: `pf_radar_load_${number}`,
      name: `Time Piloto ${number}`,
      slug: `time-piloto-${number}`,
      instagram: `timepilotoload${number}`,
      city: "Joinville",
      state: "SC",
      cityCode: "4209102",
      latitude: -26.3045 + (index % 6) * 0.002,
      longitude: -48.8487 + Math.floor(index / 6) * 0.002,
      email: `time${number}@load.local.invalid`
    });
  });
}

function setupAccounts(env = process.env) {
  const rawCount = String(env.RADAR_STAGING_TEST_TEAM_COUNT || "0").trim();
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 0 || count > 30) {
    throw new Error("RADAR_STAGING_TEST_TEAM_COUNT must be an integer between 0 and 30");
  }
  if (count > 0 && env.NODE_ENV !== "staging") {
    throw new Error("RADAR_STAGING_TEST_TEAM_COUNT is allowed only in staging");
  }
  return Object.freeze([...accounts, ...stagingLoadAccounts(count)]);
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for local setup`);
  return value;
}

function assertLocalDataPath(value) {
  const root = path.resolve(__dirname, "..", "dados");
  const resolved = path.resolve(value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("OMASCOTE_DATA_DIR must stay inside this worktree's dados directory");
  }
  return resolved;
}

function writeLocalAccounts(dataDirectory, password, accountList = accounts) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(password, 8);
  const clients = {};
  for (const account of accountList) {
    clients[account.login] = {
      cliente_id: account.accountReference,
      perfil_id: account.profileId,
      nome_time: account.name,
      email: account.email,
      ativo: true,
      plano: "piloto_radar_local",
      ciclo_mes: "202608",
      usados_no_ciclo: 0,
      saldo: 0,
      senha_hash: passwordHash,
      criado_em: now
    };
    const profileDirectory = path.join(dataDirectory, "perfis", account.profileId);
    fs.mkdirSync(profileDirectory, { recursive: true });
    fs.writeFileSync(path.join(profileDirectory, "perfil.json"), JSON.stringify({
      perfil_id: account.profileId,
      slug: account.slug,
      nome_time: account.name,
      cidade: account.city,
      estado: account.state,
      instagram: account.instagram,
      escudo_url: "/icons/icon-192.png",
      escudo_path: "",
      mascote_url: "",
      mascote_path: "",
      descricao_curta: "Conta local do piloto Radar.",
      titulo_secao_resultados: "",
      titulo_secao_proximo_jogo: "",
      publico: true,
      criado_em: now,
      atualizado_em: now
    }, null, 2), "utf8");
  }
  fs.writeFileSync(path.join(dataDirectory, "clientes.json"), JSON.stringify(clients, null, 2), "utf8");
}

async function seedRadar(pool, accountList = accounts) {
  for (const account of accountList.filter(item => item.pilot !== false)) {
    await pool.query(`
      INSERT INTO radar_team_profiles(
        legacy_profile_id, account_reference, public_slug, status,
        instagram_handle, instagram_verification_status,
        city_ibge_code, city_name, state_code,
        approximate_latitude, approximate_longitude,
        modalities, categories, declared_level, travel_radius_km,
        venue_preference, availability_active, radar_terms_accepted_at,
        public_name, public_profile_enabled, public_crest_available
      ) VALUES (
        $1, $2, $3, 'active', $4, 'verified', $5, $6, $7,
        $8, $9, ARRAY['society'], ARRAY['Livre'], 'intermediario', 50,
        'either', true, now(), $10, true, true
      )
      ON CONFLICT (legacy_profile_id) DO UPDATE SET
        account_reference = EXCLUDED.account_reference,
        public_slug = EXCLUDED.public_slug,
        status = 'active', instagram_handle = EXCLUDED.instagram_handle,
        instagram_verification_status = 'verified',
        city_ibge_code = EXCLUDED.city_ibge_code, city_name = EXCLUDED.city_name,
        state_code = EXCLUDED.state_code,
        approximate_latitude = EXCLUDED.approximate_latitude,
        approximate_longitude = EXCLUDED.approximate_longitude,
        modalities = EXCLUDED.modalities, categories = EXCLUDED.categories,
        declared_level = EXCLUDED.declared_level, travel_radius_km = 50,
        venue_preference = 'either', availability_active = true,
        radar_terms_accepted_at = COALESCE(radar_team_profiles.radar_terms_accepted_at, now()),
        public_name = EXCLUDED.public_name, public_profile_enabled = true,
        public_crest_available = true, radar_departed_at = NULL, suspended_at = NULL,
        suspension_reason = NULL, updated_at = now()
    `, [
      account.profileId, account.accountReference, account.slug, account.instagram,
      account.cityCode, account.city, account.state, account.latitude,
      account.longitude, account.name
    ]);
  }

  const moderator = accountList.find(item => item.moderator);
  if (moderator) {
    await pool.query(`
      INSERT INTO radar_account_roles(account_reference, role, granted_by_account_reference)
      VALUES ($1, 'radar_moderator', $1)
      ON CONFLICT (account_reference, role) DO UPDATE SET
        active = true, revoked_by_account_reference = NULL, revoked_at = NULL
    `, [moderator.accountReference]);
  }
}

async function main() {
  required("JWT_SECRET");
  const password = required("RADAR_LOCAL_TEST_PASSWORD");
  const dataDirectory = assertLocalDataPath(required("OMASCOTE_DATA_DIR"));
  const config = createRadarConfig(process.env);
  if (!config.databaseEmbeddedPath && !config.databaseUrl) {
    throw new Error("Configure RADAR_DATABASE_EMBEDDED_PATH or DATABASE_URL");
  }
  const accountList = setupAccounts();
  writeLocalAccounts(dataDirectory, password, accountList);
  const pool = createPool(config);
  try {
    const applied = await migrate({ pool });
    await seedRadar(pool, accountList);
    process.stdout.write(JSON.stringify({
      ok: true,
      migrations_applied: applied.length,
      accounts: accountList.map(({ login, accountReference, moderator = false, pilot = true }) => ({
        login,
        account_reference: accountReference,
        moderator,
        pilot
      }))
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Radar local setup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  accounts,
  stagingLoadAccounts,
  setupAccounts,
  assertLocalDataPath,
  writeLocalAccounts,
  seedRadar
};
