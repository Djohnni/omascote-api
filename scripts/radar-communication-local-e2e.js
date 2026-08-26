"use strict";

const crypto = require("node:crypto");

const baseUrl = String(process.env.RADAR_LOCAL_API_BASE || "").replace(/\/$/, "");
const password = String(process.env.RADAR_LOCAL_TEST_PASSWORD || "");
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) throw new Error("RADAR_LOCAL_API_BASE must be loopback HTTP");
if (!password) throw new Error("RADAR_LOCAL_TEST_PASSWORD is required");

const proof = [];
const key = label => `phase9-${label}-${crypto.randomUUID()}`;

async function call(label, { token, route, method = "GET", body, expected = [200], idempotencyKey, ifMatch }) {
  const headers = { Accept: "application/json", "X-Request-Id": key(`request-${label}`) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (ifMatch) headers["If-Match"] = ifMatch;
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  proof.push({ step: label, method, route: route.replace(/[0-9a-f-]{36}/gi, ":opaque"), status: response.status });
  if (!expected.includes(response.status)) throw new Error(`${label} failed (${response.status} ${data.code || "unknown"})`);
  return { data, response };
}

async function login(name) {
  const result = await call(`login-${name}`, {
    route: "/auth/login", method: "POST", body: { whatsapp: name, senha: password }
  });
  if (!result.data.token) throw new Error("Local login failed");
  return result.data.token;
}

async function main() {
  await call("health", { route: "/health/ready" });
  const [alpha, beta, moderator, outsider] = await Promise.all([
    login("radar_alpha"), login("radar_beta"), login("radar_moderador"), login("radar_fora")
  ]);
  const betaProfile = await call("profile-beta", { token: beta, route: "/me/time/radar" });
  const betaPublicId = betaProfile.data.profile.public_id;
  const start = new Date(Date.now() + 7 * 86_400_000);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const invitation = await call("invite", {
    token: alpha, route: "/amistosos/convites", method: "POST", expected: [201],
    idempotencyKey: key("invite"), body: {
      opponent_public_id: betaPublicId,
      starts_at: start.toISOString(), ends_at: end.toISOString(),
      modality: "society", category: "Livre", venue_preference: "either",
      message: "Convite local de comunicação."
    }
  });
  const invitationId = invitation.data.invitation.invitation_id;
  const accepted = await call("accept", {
    token: beta, route: `/amistosos/convites/${invitationId}/aceitar`, method: "POST",
    ifMatch: `W/\"${invitation.data.invitation.version}\"`, idempotencyKey: key("accept"), body: {}
  });
  const matchId = accepted.data.match.match_id;
  const channelsA = await call("channels-alpha", { token: alpha, route: `/me/time/amistosos/${matchId}/comunicacao` });
  const channelsB = await call("channels-beta", { token: beta, route: `/me/time/amistosos/${matchId}/comunicacao` });
  if (!channelsA.data.channels?.internal?.available || !channelsB.data.channels?.internal?.available) throw new Error("Internal channel missing");
  if (!channelsA.data.channels?.whatsapp?.available || !channelsA.data.channels?.instagram?.available) throw new Error("External channels missing");
  await call("outsider-private-404", { token: outsider, route: `/me/time/amistosos/${matchId}/mensagens`, expected: [404] });
  const sendKey = key("send-alpha");
  const sentA = await call("message-alpha", {
    token: alpha, route: `/me/time/amistosos/${matchId}/mensagens`, method: "POST",
    expected: [201], idempotencyKey: sendKey, body: { texto: "Olá! Vamos combinar os detalhes por aqui." }
  });
  const replay = await call("message-alpha-replay", {
    token: alpha, route: `/me/time/amistosos/${matchId}/mensagens`, method: "POST",
    expected: [201], idempotencyKey: sendKey, body: { texto: "Olá! Vamos combinar os detalhes por aqui." }
  });
  if (!replay.data.replayed) throw new Error("Message replay was not idempotent");
  const inbox = await call("messages-beta", { token: beta, route: `/me/time/amistosos/${matchId}/mensagens` });
  if (inbox.data.unread !== 1) throw new Error("Unread counter missing");
  await call("read-beta", {
    token: beta, route: `/me/time/amistosos/${matchId}/mensagens/lidas`, method: "POST",
    idempotencyKey: key("read"), body: { ultima_mensagem_id: sentA.data.message.message_id }
  });
  const sentB = await call("message-beta", {
    token: beta, route: `/me/time/amistosos/${matchId}/mensagens`, method: "POST",
    expected: [201], idempotencyKey: key("send-beta"), body: { texto: "Combinado! Confirmamos o horário." }
  });
  const report = await call("report-message", {
    token: alpha, route: `/me/time/amistosos/${matchId}/mensagens/${sentB.data.message.message_id}/denunciar`,
    method: "POST", expected: [201], idempotencyKey: key("report"), body: { categoria: "other" }
  });
  const queue = await call("moderation-queue", { token: moderator, route: "/admin/radar/moderacao?limit=20" });
  const item = queue.data.items.find(value => value.case_id === report.data.case.case_id);
  if (!item?.reported_message?.texto) throw new Error("Reported message did not reach moderation");
  const assigned = await call("moderation-assign", {
    token: moderator, route: `/admin/radar/moderacao/${item.case_id}/atribuir`, method: "POST",
    ifMatch: `W/\"${item.version}\"`, idempotencyKey: key("assign"), body: { motivo: "triage" }
  });
  await call("moderation-resolve", {
    token: moderator, route: `/admin/radar/moderacao/${item.case_id}/resolver`, method: "POST",
    ifMatch: `W/\"${assigned.data.case.version}\"`, idempotencyKey: key("resolve"),
    body: { decisao: "dismiss", motivo: "no_violation" }
  });
  await call("block", {
    token: alpha, route: "/me/time/radar/bloqueios", method: "POST", expected: [201],
    idempotencyKey: key("block"), body: { team_public_id: betaPublicId, motivo: "unwanted_contact" }
  });
  const blockedChannels = await call("channels-blocked", { token: alpha, route: `/me/time/amistosos/${matchId}/comunicacao` });
  if (blockedChannels.data.can_send !== false || blockedChannels.data.channels.whatsapp.available) throw new Error("Block did not hide contact");
  await call("blocked-send", {
    token: alpha, route: `/me/time/amistosos/${matchId}/mensagens`, method: "POST", expected: [403],
    idempotencyKey: key("blocked-send"), body: { texto: "Mensagem bloqueada" }
  });
  await call("history-while-blocked", { token: alpha, route: `/me/time/amistosos/${matchId}/mensagens` });
  await call("unblock", {
    token: alpha, route: `/me/time/radar/bloqueios/${betaPublicId}`, method: "DELETE",
    idempotencyKey: key("unblock")
  });
  const finalMessages = await call("messages-final", { token: alpha, route: `/me/time/amistosos/${matchId}/mensagens` });
  if (finalMessages.data.items.length !== 2) throw new Error("Final conversation is not clean");
  await call("session-expired", { route: `/me/time/amistosos/${matchId}/mensagens`, expected: [401] });
  process.stdout.write(`${JSON.stringify({
    ok: true, checks: proof.length, messages: finalMessages.data.items.length,
    channels: ["whatsapp", "instagram", "internal"],
    no_pending_reports: true, no_active_blocks: true, proof
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`Radar communication local E2E failed: ${error.message}\n`);
  process.exitCode = 1;
});
