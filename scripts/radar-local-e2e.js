"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const baseUrl = String(process.env.RADAR_LOCAL_API_BASE || "").replace(/\/$/, "");
const password = String(process.env.RADAR_LOCAL_TEST_PASSWORD || "");
const proofFile = String(process.env.RADAR_LOCAL_PROOF_FILE || "").trim();
const proof = [];

if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) {
  throw new Error("RADAR_LOCAL_API_BASE must be an explicit loopback HTTP origin");
}
if (!password) throw new Error("RADAR_LOCAL_TEST_PASSWORD is required");

function key(label) {
  return `phase6a-${label}-${crypto.randomUUID()}`;
}

function etagFor(value) {
  const version = Number(value?.version);
  if (!Number.isInteger(version) || version < 1) throw new Error("Missing resource version");
  return `W/\"${version}\"`;
}

function record(label, method, route, response) {
  proof.push(Object.freeze({
    step: label,
    method,
    route: route.split("?")[0],
    status: response.status,
    etag: response.headers.get("etag") || null,
    cache_control: response.headers.get("cache-control") || null
  }));
}

async function call(label, { token, method = "GET", route, body, idempotencyKey, ifMatch, expected = [200] }) {
  const headers = { Accept: "application/json", "X-Request-Id": key(`request-${label}`) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (ifMatch) headers["If-Match"] = ifMatch;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  record(label, method, route, response);
  const data = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) {
    throw new Error(`${label} failed (${response.status} ${data.code || data.error || "unknown"})`);
  }
  return { response, data };
}

async function login(loginName) {
  const result = await call(`login-${loginName}`, {
    method: "POST",
    route: "/auth/login",
    body: { whatsapp: loginName, senha: password }
  });
  if (!result.data.token) throw new Error(`Login did not return a token for ${loginName}`);
  return result.data.token;
}

async function waitUntil(iso) {
  const remaining = new Date(iso).getTime() - Date.now() + 350;
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

async function main() {
  await call("readiness", { route: "/health/ready" });
  await call("session-expired", {
    route: "/me/time/radar/elegibilidade",
    expected: [401]
  });

  const [alpha, beta, moderator, outside] = await Promise.all([
    login("radar_alpha"),
    login("radar_beta"),
    login("radar_moderador"),
    login("radar_fora")
  ]);

  await call("pilot-access-denied", {
    token: outside,
    route: "/me/time/radar/elegibilidade",
    expected: [403]
  });
  await call("eligibility-alpha", { token: alpha, route: "/me/time/radar/elegibilidade" });
  await call("eligibility-beta", { token: beta, route: "/me/time/radar/elegibilidade" });
  const betaProfile = await call("profile-beta", { token: beta, route: "/me/time/radar" });
  const betaPublicId = betaProfile.data.profile?.public_id;
  if (!betaPublicId) throw new Error("Beta public team id was not returned");

  const availabilityStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const availabilityEnd = new Date(availabilityStart.getTime() + 2 * 60 * 60 * 1000);
  const availability = {
    modality: "society",
    category: "Livre",
    starts_at: availabilityStart.toISOString(),
    ends_at: availabilityEnd.toISOString(),
    travel_radius_km: 50,
    venue_preference: "either",
    status: "active"
  };
  const alphaAvailabilityKey = key("availability-alpha");
  await call("availability-alpha", {
    token: alpha, method: "POST", route: "/me/time/amistosos/disponibilidades",
    body: availability, idempotencyKey: alphaAvailabilityKey, expected: [201]
  });
  await call("availability-alpha-replay", {
    token: alpha, method: "POST", route: "/me/time/amistosos/disponibilidades",
    body: availability, idempotencyKey: alphaAvailabilityKey, expected: [200]
  });
  await call("availability-beta", {
    token: beta, method: "POST", route: "/me/time/amistosos/disponibilidades",
    body: availability, idempotencyKey: key("availability-beta"), expected: [201]
  });
  const search = await call("search", {
    token: alpha,
    route: "/amistosos/times-proximos?modality=society&category=Livre&radius_km=50&limit=10"
  });
  if (!search.data.items?.some(item => item.slug === "uniao-vila-local")) {
    throw new Error("The real search did not return the second local team");
  }

  const firstStart = new Date(Date.now() + 15_000);
  const firstEnd = new Date(firstStart.getTime() + 2 * 60 * 60 * 1000);
  const invitation = await call("invitation-create", {
    token: alpha, method: "POST", route: "/amistosos/convites",
    idempotencyKey: key("invitation-create"), expected: [201],
    body: {
      opponent_slug: "uniao-vila-local",
      starts_at: firstStart.toISOString(), ends_at: firstEnd.toISOString(),
      modality: "society", category: "Livre", venue_preference: "either",
      message: "Amistoso local de integracao."
    }
  });
  const invitationId = invitation.data.invitation?.invitation_id;
  if (!invitationId) throw new Error("Invitation id missing");
  await call("invitation-inbox", { token: beta, route: "/me/time/amistosos/convites?caixa=entrada" });

  const counterStart = new Date(Date.now() + 25_000);
  const counterEnd = new Date(counterStart.getTime() + 2 * 60 * 60 * 1000);
  const counter = await call("invitation-counter", {
    token: beta, method: "POST", route: `/amistosos/convites/${invitationId}/contrapropor`,
    ifMatch: etagFor(invitation.data.invitation), idempotencyKey: key("invitation-counter"),
    body: {
      starts_at: counterStart.toISOString(), ends_at: counterEnd.toISOString(),
      modality: "society", category: "Livre", venue_preference: "either",
      message: "Novo horario local."
    }
  });
  await call("invitation-version-conflict", {
    token: alpha, method: "POST", route: `/amistosos/convites/${invitationId}/aceitar`,
    ifMatch: 'W/"1"', idempotencyKey: key("invitation-stale"), body: {}, expected: [409]
  });
  const acceptKey = key("invitation-accept");
  const accepted = await call("invitation-accept", {
    token: alpha, method: "POST", route: `/amistosos/convites/${invitationId}/aceitar`,
    ifMatch: etagFor(counter.data.invitation), idempotencyKey: acceptKey, body: {}
  });
  await call("invitation-accept-replay", {
    token: alpha, method: "POST", route: `/amistosos/convites/${invitationId}/aceitar`,
    ifMatch: etagFor(counter.data.invitation), idempotencyKey: acceptKey, body: {}
  });
  const matchId = accepted.data.match?.match_id;
  if (!matchId) throw new Error("Accepted invitation did not create a match");

  const matchAlpha = await call("match-detail-alpha", { token: alpha, route: `/me/time/amistosos/${matchId}` });
  if (!matchAlpha.data.match?.contact_unlocked || !matchAlpha.data.match?.opponent_contact) {
    throw new Error("Accepted match did not unlock the participant contact");
  }
  await waitUntil(counterStart.toISOString());
  const occurrenceAlphaKey = key("occurrence-alpha");
  const occurrenceAlpha = await call("occurrence-alpha", {
    token: alpha, method: "POST", route: `/me/time/amistosos/${matchId}/confirmar-realizacao`,
    ifMatch: matchAlpha.response.headers.get("etag"), idempotencyKey: occurrenceAlphaKey, body: {}
  });
  await call("occurrence-alpha-replay", {
    token: alpha, method: "POST", route: `/me/time/amistosos/${matchId}/confirmar-realizacao`,
    ifMatch: matchAlpha.response.headers.get("etag"), idempotencyKey: occurrenceAlphaKey, body: {}
  });
  const matchBeta = await call("match-detail-beta", { token: beta, route: `/me/time/amistosos/${matchId}` });
  const occurrenceBeta = await call("occurrence-beta", {
    token: beta, method: "POST", route: `/me/time/amistosos/${matchId}/confirmar-realizacao`,
    ifMatch: matchBeta.response.headers.get("etag"), idempotencyKey: key("occurrence-beta"), body: {}
  });
  if (occurrenceBeta.data.match?.state !== "played") throw new Error("Two confirmations did not mark the match as played");

  const beforeScore = await call("match-before-score", { token: alpha, route: `/me/time/amistosos/${matchId}` });
  await call("score-alpha", {
    token: alpha, method: "POST", route: `/me/time/amistosos/${matchId}/resultado`,
    ifMatch: beforeScore.response.headers.get("etag"), idempotencyKey: key("score-alpha"),
    body: { gols_meu_time: 3, gols_adversario: 1 }
  });
  const scoreForBeta = await call("score-detail-beta", { token: beta, route: `/me/time/amistosos/${matchId}` });
  const confirmedScore = await call("score-confirm-beta", {
    token: beta, method: "POST", route: `/me/time/amistosos/${matchId}/resultado/confirmar`,
    ifMatch: scoreForBeta.response.headers.get("etag"), idempotencyKey: key("score-confirm-beta"), body: {}
  });
  if (confirmedScore.data.match?.result?.state !== "verified") throw new Error("Cross-confirmed score is not verified");

  const history = await call("history", { token: alpha, route: "/me/time/amistosos/historico?limit=10" });
  if (!history.data.items?.some(item => item.match_id === matchId)) throw new Error("Verified match missing from history");
  const pending = await call("review-pending", { token: alpha, route: "/me/time/avaliacoes/pendentes" });
  if (!pending.data.items?.some(item => item.match_id === matchId)) throw new Error("Verified match missing from pending reviews");
  await call("review-alpha", {
    token: alpha, method: "POST", route: `/me/time/amistosos/${matchId}/avaliacao`,
    idempotencyKey: key("review-alpha"),
    body: { pontualidade: 5, organizacao: 4, comunicacao: 5, fair_play: 5, jogaria_novamente: true }
  });
  await call("reputation-beta", { token: beta, route: "/me/time/reputacao" });

  await call("block-beta", {
    token: alpha, method: "POST", route: "/me/time/radar/bloqueios",
    idempotencyKey: key("block-beta"),
    body: { team_public_id: betaPublicId, motivo: "unwanted_contact" }, expected: [201]
  });
  const reported = await call("report-match", {
    token: alpha, method: "POST", route: "/me/time/radar/denuncias",
    idempotencyKey: key("report-match"), expected: [201],
    body: { tipo: "partida", match_id: matchId, categoria: "unsafe_conduct", descricao: "Relato privado local." }
  });
  const caseId = reported.data.case?.case_id;
  if (!caseId) throw new Error("Moderation case id missing");
  const queue = await call("moderation-queue", { token: moderator, route: "/admin/radar/moderacao?limit=20" });
  const moderationCase = queue.data.items?.find(item => item.case_id === caseId);
  if (!moderationCase) throw new Error("Submitted case missing from moderation queue");
  const assigned = await call("moderation-assign", {
    token: moderator, method: "POST", route: `/admin/radar/moderacao/${caseId}/atribuir`,
    ifMatch: etagFor(moderationCase), idempotencyKey: key("moderation-assign"), body: { motivo: "triage" }
  });
  await call("moderation-resolve", {
    token: moderator, method: "POST", route: `/admin/radar/moderacao/${caseId}/resolver`,
    ifMatch: etagFor(assigned.data.case), idempotencyKey: key("moderation-resolve"),
    body: { decisao: "warn", motivo: "violation_confirmed" }
  });
  await call("notifications-alpha", { token: alpha, route: "/me/notificacoes?limit=20" });

  const result = Object.freeze({
    ok: true,
    mode: "local-real-api-postgresql",
    checks: proof.length,
    completed: [
      "eligibility", "availability", "search", "invitation", "counterproposal", "acceptance",
      "match", "occurrence", "score", "cross_confirmation", "history", "review", "reputation",
      "block", "report", "moderation", "session", "pilot_allowlist", "version_conflict", "idempotency"
    ],
    proof
  });
  if (proofFile) {
    const resolved = path.resolve(proofFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`Radar local E2E failed: ${error.message}\n`);
  process.exitCode = 1;
});
