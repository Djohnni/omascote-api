"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const express = require("express");
const { createRadarConfig } = require("./src/config/radar");
const {
  BRAZILIAN_STATE_CODES,
  CATALOG_METADATA,
  CITIES,
  resolveBrazilianCity,
  suggestBrazilianCities
} = require("./src/friendlies/brazil-city-catalog");
const { buildRadarEligibility } = require("./src/friendlies/radar-identity.service");
const { haversineKm } = require("./src/friendlies/friendly-search.compatibility");
const { createRadarIdentityRouter } = require("./src/friendlies/radar-identity.routes");
const snapshot = require("./src/friendlies/data/brazilian-municipalities-2025.json");

async function request(app, pathname) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function completeTeam(city) {
  return {
    status: "active",
    suspendedAt: null,
    cityName: city.name,
    stateCode: city.stateCode,
    cityIbgeCode: city.ibgeCode,
    instagramHandle: "time.nacional",
    instagramVerificationStatus: "verified",
    modalities: ["society"],
    categories: ["Livre"],
    termsAcceptedAt: "2026-08-26T00:00:00.000Z",
    availabilityActive: true
  };
}

const publicLegacyProfile = Object.freeze({
  nome_time: "Time Nacional",
  publico: true,
  escudo_url: "/escudos/time-nacional.png"
});

test("versioned local catalog has 5571 valid unique municipalities and every UF plus DF", () => {
  assert.equal(CITIES.length, 5571);
  assert.equal(CATALOG_METADATA.catalog_version, "IBGE-Localidades-current+MMD-2025");
  assert.equal(new Set(CITIES.map(city => city.ibgeCode)).size, 5571);
  assert.equal(new Set(CITIES.map(city => `${city.stateCode}:${city.name}`)).size, 5571);
  assert.deepEqual([...new Set(CITIES.map(city => city.stateCode))].sort(), [...BRAZILIAN_STATE_CODES].sort());
  assert.ok(CITIES.every(city => /^\d{7}$/.test(city.ibgeCode)));
  assert.ok(CITIES.every(city => Number.isFinite(city.latitude) && Number.isFinite(city.longitude)));
  const checksum = crypto.createHash("sha256")
    .update(JSON.stringify(snapshot.municipalities)).digest("hex");
  assert.equal(checksum, CATALOG_METADATA.catalog_sha256);
  const runtimeSource = fs.readFileSync(require.resolve("./src/friendlies/brazil-city-catalog"), "utf8");
  assert.doesNotMatch(runtimeSource, /\bfetch\s*\(|https?:\/\//);
});

test("Ascurra SC, capitals, small cities, accents, case and extra spaces resolve canonically", () => {
  assert.deepEqual(resolveBrazilianCity("  ASCURRA  ", " sc "), {
    ibgeCode: "4201703",
    name: "Ascurra",
    stateCode: "SC",
    latitude: -26.973634,
    longitude: -49.395966
  });
  assert.equal(resolveBrazilianCity("sao paulo", "sp").name, "São Paulo");
  assert.equal(resolveBrazilianCity("BRASÍLIA", "df").ibgeCode, "5300108");
  assert.equal(resolveBrazilianCity("Borá", "SP").ibgeCode, "3507209");
  assert.equal(resolveBrazilianCity("  sao   joao   do   oeste ", "SC").name, "São João do Oeste");
});

test("every state has a resolvable municipality and obsolete city-pilot input cannot restrict eligibility", () => {
  const config = createRadarConfig({
    RADAR_AMISTOSOS_ENABLED: "true",
    RADAR_PILOT_CITY_IBGE_CODE: "4209102"
  });
  assert.equal(Object.hasOwn(config, "pilotCityIbgeCode"), false);
  for (const stateCode of BRAZILIAN_STATE_CODES) {
    const city = CITIES.find(item => item.stateCode === stateCode);
    assert.ok(city, `missing ${stateCode}`);
    assert.equal(resolveBrazilianCity(city.name, stateCode).ibgeCode, city.ibgeCode);
    const eligibility = buildRadarEligibility({
      team: completeTeam(city),
      legacyProfile: publicLegacyProfile,
      config
    });
    assert.equal(eligibility.eligible, true, `${city.name}/${stateCode} should be eligible`);
    assert.equal(Object.hasOwn(eligibility, "inside_pilot"), false);
    assert.equal(eligibility.missing.includes("outside_pilot_city"), false);
  }
});

test("wrong UF and nonexistent city fail with the short safe message", () => {
  for (const [city, state] of [["Ascurra", "PR"], ["Cidade Inventada", "SC"]]) {
    assert.throws(
      () => resolveBrazilianCity(city, state),
      error => error.code === "RADAR_CITY_INVALID" && error.message === "Confira a cidade e a UF."
    );
  }
});

test("suggestions expose only city and UF and accept unaccented queries", async () => {
  const direct = suggestBrazilianCities("asc", "sc");
  assert.deepEqual(direct[0], { city_name: "Ascurra", state_code: "SC" });
  assert.equal(JSON.stringify(direct).includes("ibge"), false);
  assert.ok(suggestBrazilianCities("sao joao", "SC").some(item => item.city_name === "São João do Oeste"));

  const app = express();
  app.use("/me/time/radar", createRadarIdentityRouter({
    config: createRadarConfig({ RADAR_AMISTOSOS_ENABLED: "true" }),
    auth(req, res, next) { req.user = { id: "allowed" }; next(); },
    async resolveIdentity() { return { accountId: "allowed", legacyProfile: {} }; },
    identityService: { async getProfile() { return { profile: null }; } }
  }));
  const response = await request(app, "/me/time/radar/cidades?busca=ascur&uf=SC");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, [{ city_name: "Ascurra", state_code: "SC" }]);
  assert.equal(JSON.stringify(response.body).includes("4201703"), false);
  assert.equal(JSON.stringify(response.body).toLowerCase().includes("ibge"), false);
});

test("catalog coordinates support approximate distance search between Brazilian cities", () => {
  const ascurra = resolveBrazilianCity("Ascurra", "SC");
  const blumenau = resolveBrazilianCity("Blumenau", "SC");
  const distance = haversineKm(
    { latitude: ascurra.latitude, longitude: ascurra.longitude },
    { latitude: blumenau.latitude, longitude: blumenau.longitude }
  );
  assert.ok(distance > 10 && distance < 60, `unexpected distance ${distance}`);
});
