"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");
const snapshot = require("./data/brazilian-municipalities-2025.json");

const BRAZILIAN_STATE_CODES = Object.freeze([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO"
]);
const STATE_PREFIXES = Object.freeze({
  AC: "12", AL: "27", AP: "16", AM: "13", BA: "29", CE: "23", DF: "53",
  ES: "32", GO: "52", MA: "21", MT: "51", MS: "50", MG: "31", PA: "15",
  PB: "25", PR: "41", PE: "26", PI: "22", RJ: "33", RN: "24", RS: "43",
  RO: "11", RR: "14", SC: "42", SP: "35", SE: "28", TO: "17"
});

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

function loadCatalog() {
  const seenCodes = new Set();
  const seenNames = new Set();
  const states = new Set();
  const cities = snapshot.municipalities.map(row => {
    if (!Array.isArray(row) || row.length !== 5) throw new Error("Invalid Brazilian city catalog row");
    const [ibgeCode, name, stateCode, latitude, longitude] = row;
    if (!/^\d{7}$/.test(ibgeCode) || STATE_PREFIXES[stateCode] !== ibgeCode.slice(0, 2)) {
      throw new Error(`Invalid Brazilian municipal code ${ibgeCode}`);
    }
    if (seenCodes.has(ibgeCode)) throw new Error(`Duplicate Brazilian municipal code ${ibgeCode}`);
    seenCodes.add(ibgeCode);
    const nameKey = `${stateCode}:${fold(name)}`;
    if (!fold(name) || seenNames.has(nameKey)) throw new Error(`Duplicate Brazilian city ${nameKey}`);
    seenNames.add(nameKey);
    states.add(stateCode);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`Invalid Brazilian city coordinates ${ibgeCode}`);
    }
    return Object.freeze({ ibgeCode, name, stateCode, latitude, longitude });
  });
  if (cities.length !== snapshot.metadata.municipality_count || cities.length !== 5571) {
    throw new Error("Incomplete Brazilian city catalog");
  }
  if (states.size !== BRAZILIAN_STATE_CODES.length || BRAZILIAN_STATE_CODES.some(code => !states.has(code))) {
    throw new Error("Brazilian city catalog does not cover every state and the Federal District");
  }
  return Object.freeze(cities);
}

const CITIES = loadCatalog();
const CITY_BY_NAME_AND_STATE = new Map(CITIES.map(city => [
  `${city.stateCode}:${fold(city.name)}`,
  city
]));
const CITY_SEARCH_INDEX = Object.freeze(CITIES.map(city => Object.freeze({
  city,
  foldedName: fold(city.name)
})));

function normalizeStateCode(stateCode) {
  return String(stateCode || "").replace(/\s+/g, "").trim().toUpperCase();
}

function resolveBrazilianCity(cityName, stateCode) {
  const city = CITY_BY_NAME_AND_STATE.get(`${normalizeStateCode(stateCode)}:${fold(cityName)}`);
  if (!city) {
    throw new RadarIdentityError(
      "RADAR_CITY_INVALID",
      400,
      "Confira a cidade e a UF."
    );
  }
  return city;
}

function suggestBrazilianCities(query, stateCode, limit = 8) {
  const term = fold(query);
  const state = normalizeStateCode(stateCode);
  if (term.length < 2) return Object.freeze([]);
  if (state && !BRAZILIAN_STATE_CODES.includes(state)) return Object.freeze([]);
  const safeLimit = Math.min(Math.max(Number(limit) || 8, 1), 10);
  return Object.freeze(CITY_SEARCH_INDEX
    .filter(item => (!state || item.city.stateCode === state) && item.foldedName.includes(term))
    .sort((left, right) => {
      const leftPrefix = left.foldedName.startsWith(term) ? 0 : 1;
      const rightPrefix = right.foldedName.startsWith(term) ? 0 : 1;
      return leftPrefix - rightPrefix || left.city.name.localeCompare(right.city.name, "pt-BR");
    })
    .slice(0, safeLimit)
    .map(item => Object.freeze({ city_name: item.city.name, state_code: item.city.stateCode })));
}

module.exports = {
  BRAZILIAN_STATE_CODES,
  CATALOG_METADATA: Object.freeze({ ...snapshot.metadata }),
  CITIES,
  fold,
  resolveBrazilianCity,
  suggestBrazilianCities
};
