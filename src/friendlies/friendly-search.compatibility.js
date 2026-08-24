"use strict";

const LEVEL_ORDER = Object.freeze({
  iniciante: 0,
  intermediario: 1,
  competitivo: 2,
  avancado: 3
});
const WEEKDAY_PT = Object.freeze({
  Monday: "segunda",
  Tuesday: "terca",
  Wednesday: "quarta",
  Thursday: "quinta",
  Friday: "sexta",
  Saturday: "sabado",
  Sunday: "domingo"
});
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: "America/Sao_Paulo"
});

function validCoordinate(latitude, longitude) {
  if (latitude === null || latitude === undefined || String(latitude).trim() === "" ||
      longitude === null || longitude === undefined || String(longitude).trim() === "") {
    return false;
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function haversineKm(first, second) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const lat1 = toRadians(Number(first.latitude));
  const lat2 = toRadians(Number(second.latitude));
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(Number(second.longitude) - Number(first.longitude));
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6_371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function candidateLocation(origin, candidate, radiusKm) {
  const bothKnown = validCoordinate(origin.approximateLatitude, origin.approximateLongitude) &&
    validCoordinate(candidate.approximateLatitude, candidate.approximateLongitude);
  if (bothKnown) {
    const distance = haversineKm(
      { latitude: origin.approximateLatitude, longitude: origin.approximateLongitude },
      { latitude: candidate.approximateLatitude, longitude: candidate.approximateLongitude }
    );
    if (distance > radiusKm) return null;
    return Object.freeze({ kind: "approximate_distance", distanceKm: distance });
  }
  if (String(origin.cityIbgeCode || "") !== String(candidate.cityIbgeCode || "")) return null;
  return Object.freeze({ kind: "same_city", distanceKm: null });
}

function normalizedSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(value => String(value || "").trim().toLowerCase()));
}

function weekdayLabel(value) {
  const english = WEEKDAY_FORMATTER.format(new Date(value));
  return WEEKDAY_PT[english] || "em breve";
}

function venueCompatible(originPreference, candidatePreference) {
  const origin = String(originPreference || "either");
  const candidate = String(candidatePreference || "either");
  if (origin === "either" || candidate === "either") return true;
  return (origin === "home" && candidate === "away") ||
    (origin === "away" && candidate === "home");
}

function buildCompatibility({ origin, candidate, location, radiusKm }) {
  const reasons = [];
  let score = 0;
  if (location.kind === "same_city") {
    score += 25;
    reasons.push("mesma cidade");
  } else {
    score += Math.max(0, Math.round(25 * (1 - location.distanceKm / radiusKm)));
    if (location.distanceKm <= Math.min(radiusKm, 10)) reasons.push("perto do seu time");
  }

  if (normalizedSet(origin.modalities).has(String(candidate.modality || "").toLowerCase())) {
    score += 25;
    reasons.push("mesma modalidade");
  }
  if (normalizedSet(origin.categories).has(String(candidate.category || "").toLowerCase())) {
    score += 20;
    reasons.push("categoria compativel");
  }

  const originLevel = LEVEL_ORDER[String(origin.declaredLevel || "").toLowerCase()];
  const candidateLevel = LEVEL_ORDER[String(candidate.declaredLevel || "").toLowerCase()];
  if (Number.isInteger(originLevel) && Number.isInteger(candidateLevel)) {
    const difference = Math.abs(originLevel - candidateLevel);
    if (difference === 0) {
      score += 15;
      reasons.push("nivel compativel");
    } else if (difference === 1) {
      score += 8;
      reasons.push("nivel proximo");
    }
  }

  if (candidate.availabilityOverlap === true) {
    score += 10;
    reasons.push(`disponivel ${weekdayLabel(candidate.startsAt)}`);
  } else {
    reasons.push(`tem horario ${weekdayLabel(candidate.startsAt)}`);
  }

  if (venueCompatible(origin.venuePreference, candidate.venuePreference)) score += 5;
  if (["away", "either"].includes(candidate.venuePreference)) reasons.push("aceita jogar fora");

  return Object.freeze({
    score: Math.max(0, Math.min(score, 100)),
    reasons: Object.freeze([...new Set(reasons)].slice(0, 5))
  });
}

function sortKey(item) {
  return Object.freeze({
    score: item.compatibility.score,
    distance: item.location.distanceKm === null ? 1_000_000 : Number(item.location.distanceKm.toFixed(3)),
    startsAt: item.startsAt,
    slug: item.publicSlug
  });
}

function compareSortKeys(first, second) {
  if (first.score !== second.score) return second.score - first.score;
  if (first.distance !== second.distance) return first.distance - second.distance;
  const time = new Date(first.startsAt).getTime() - new Date(second.startsAt).getTime();
  if (time !== 0) return time;
  return String(first.slug).localeCompare(String(second.slug), "en");
}

module.exports = {
  validCoordinate,
  haversineKm,
  candidateLocation,
  venueCompatible,
  buildCompatibility,
  sortKey,
  compareSortKeys
};
