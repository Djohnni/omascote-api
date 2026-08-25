"use strict";

const { RadarIdentityError } = require("./radar-identity.errors");

// Catalogo versionado e local. O piloto nao depende de consulta externa no cadastro.
// Novas cidades entram por revisao de codigo com dados canonicos do IBGE.
const CITIES = Object.freeze([
  Object.freeze({ ibgeCode: "4209102", name: "Joinville", stateCode: "SC", latitude: -26.3044, longitude: -48.8487 }),
  Object.freeze({ ibgeCode: "3550308", name: "São Paulo", stateCode: "SP", latitude: -23.5505, longitude: -46.6333 }),
  Object.freeze({ ibgeCode: "3304557", name: "Rio de Janeiro", stateCode: "RJ", latitude: -22.9068, longitude: -43.1729 }),
  Object.freeze({ ibgeCode: "4106902", name: "Curitiba", stateCode: "PR", latitude: -25.4284, longitude: -49.2733 }),
  Object.freeze({ ibgeCode: "4205407", name: "Florianópolis", stateCode: "SC", latitude: -27.5949, longitude: -48.5482 }),
  Object.freeze({ ibgeCode: "4314902", name: "Porto Alegre", stateCode: "RS", latitude: -30.0346, longitude: -51.2177 }),
  Object.freeze({ ibgeCode: "3106200", name: "Belo Horizonte", stateCode: "MG", latitude: -19.9167, longitude: -43.9345 }),
  Object.freeze({ ibgeCode: "5300108", name: "Brasília", stateCode: "DF", latitude: -15.7939, longitude: -47.8828 }),
  Object.freeze({ ibgeCode: "2927408", name: "Salvador", stateCode: "BA", latitude: -12.9777, longitude: -38.5016 }),
  Object.freeze({ ibgeCode: "2304400", name: "Fortaleza", stateCode: "CE", latitude: -3.7319, longitude: -38.5267 }),
  Object.freeze({ ibgeCode: "2611606", name: "Recife", stateCode: "PE", latitude: -8.0476, longitude: -34.8770 }),
  Object.freeze({ ibgeCode: "1302603", name: "Manaus", stateCode: "AM", latitude: -3.1190, longitude: -60.0217 }),
  Object.freeze({ ibgeCode: "1501402", name: "Belém", stateCode: "PA", latitude: -1.4558, longitude: -48.4902 }),
  Object.freeze({ ibgeCode: "5208707", name: "Goiânia", stateCode: "GO", latitude: -16.6869, longitude: -49.2648 }),
  Object.freeze({ ibgeCode: "3509502", name: "Campinas", stateCode: "SP", latitude: -22.9099, longitude: -47.0626 }),
  Object.freeze({ ibgeCode: "3549805", name: "São José do Rio Preto", stateCode: "SP", latitude: -20.8113, longitude: -49.3758 }),
  Object.freeze({ ibgeCode: "3543402", name: "Ribeirão Preto", stateCode: "SP", latitude: -21.1699, longitude: -47.8099 }),
  Object.freeze({ ibgeCode: "3548708", name: "São Bernardo do Campo", stateCode: "SP", latitude: -23.6914, longitude: -46.5646 }),
  Object.freeze({ ibgeCode: "3518800", name: "Guarulhos", stateCode: "SP", latitude: -23.4543, longitude: -46.5337 }),
  Object.freeze({ ibgeCode: "3205309", name: "Vitória", stateCode: "ES", latitude: -20.3155, longitude: -40.3128 })
]);

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

function resolveBrazilianCity(cityName, stateCode) {
  const city = fold(cityName);
  const state = String(stateCode || "").trim().toUpperCase();
  const match = CITIES.find(item => item.stateCode === state && fold(item.name) === city);
  if (!match) {
    throw new RadarIdentityError(
      "RADAR_CITY_NOT_SUPPORTED",
      400,
      "Cidade e UF ainda nao estao disponiveis no Radar."
    );
  }
  return match;
}

module.exports = { CITIES, fold, resolveBrazilianCity };
