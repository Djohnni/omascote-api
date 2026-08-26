"use strict";

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

function candidateLocation(origin, candidate, radiusKm = null) {
  const bothKnown = validCoordinate(origin.approximateLatitude, origin.approximateLongitude) &&
    validCoordinate(candidate.approximateLatitude, candidate.approximateLongitude);
  if (bothKnown) {
    const distance = haversineKm(
      { latitude: origin.approximateLatitude, longitude: origin.approximateLongitude },
      { latitude: candidate.approximateLatitude, longitude: candidate.approximateLongitude }
    );
    if (Number.isFinite(radiusKm) && distance > radiusKm) return null;
    return Object.freeze({ kind: "approximate_distance", distanceKm: distance });
  }
  const originCity = String(origin.cityIbgeCode || "");
  const candidateCity = String(candidate.cityIbgeCode || "");
  if (originCity && candidateCity && originCity === candidateCity) {
    return Object.freeze({ kind: "same_city", distanceKm: null });
  }
  return Object.freeze({ kind: "unknown", distanceKm: null });
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
  } else if (location.kind === "approximate_distance") {
    const scale = Math.max(Number(radiusKm || 100), location.distanceKm || 0, 1);
    score += Math.max(0, Math.round(25 * (1 - location.distanceKm / scale)));
    if (location.distanceKm <= Math.min(scale, 10)) reasons.push("perto do seu time");
  }

  const candidateModalities = normalizedSet([
    ...(candidate.modalities || []),
    candidate.modality
  ]);
  if ([...normalizedSet(origin.modalities)].some(value => candidateModalities.has(value))) {
    score += 25;
    reasons.push("mesma modalidade");
  }
  const candidateCategories = normalizedSet([
    ...(candidate.categories || []),
    candidate.category
  ]);
  if ([...normalizedSet(origin.categories)].some(value => candidateCategories.has(value))) {
    score += 20;
    reasons.push("categoria compativel");
  }

  if (!candidate.startsAt) {
    reasons.push("horario a combinar");
  } else if (candidate.availabilityOverlap === true) {
    score += 25;
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
    distance: item.location.kind === "unknown"
      ? 2_000_000
      : item.location.distanceKm === null
        ? 1_000_000
        : Number(item.location.distanceKm.toFixed(3)),
    startsAt: item.startsAt || "9999-12-31T23:59:59.999Z",
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
