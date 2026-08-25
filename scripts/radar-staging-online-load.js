"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { stagingLoadAccounts } = require("./radar-local-setup");

const baseUrl = String(process.env.RADAR_STAGING_API_BASE || "").replace(/\/$/, "");
const password = String(process.env.RADAR_LOCAL_TEST_PASSWORD || "");
const proofFile = String(process.env.RADAR_STAGING_LOAD_PROOF_FILE || "").trim();
const parsedBase = new URL(baseUrl || "https://invalid.invalid");

if (
  parsedBase.protocol !== "https:" ||
  parsedBase.hostname !== "omascote-radar-api-staging.onrender.com" ||
  process.env.NODE_ENV === "production"
) {
  throw new Error("Staging load test refuses non-staging or production targets");
}
if (!password) throw new Error("RADAR_LOCAL_TEST_PASSWORD is required");

const teams = stagingLoadAccounts(30);
const samples = [];
const unexpected = [];

function key(label) {
  return `staging-load-${label}-${crypto.randomUUID()}`;
}

function etag(item) {
  const version = Number(item?.version);
  if (!Number.isInteger(version)) throw new Error("Resource version missing");
  return `W/\"${version}\"`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize() {
  const groups = new Map();
  for (const sample of samples) {
    const values = groups.get(sample.operation) || [];
    values.push(sample.duration_ms);
    groups.set(sample.operation, values);
  }
  return Object.fromEntries([...groups].map(([operation, values]) => [operation, {
    requests: values.length,
    p50_ms: Number(percentile(values, 0.50).toFixed(2)),
    p95_ms: Number(percentile(values, 0.95).toFixed(2)),
    p99_ms: Number(percentile(values, 0.99).toFixed(2)),
    max_ms: Number(Math.max(...values).toFixed(2))
  }]));
}

async function call(operation, route, options = {}) {
  const headers = { Accept: "application/json", "X-Request-Id": key(`request-${operation}`) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  if (options.etag) headers["If-Match"] = options.etag;
  const started = process.hrtime.bigint();
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  samples.push({ operation, duration_ms: durationMs, status: response.status });
  const data = await response.json().catch(() => ({}));
  const expected = options.expected || [200, 201];
  if (!expected.includes(response.status)) {
    unexpected.push({ operation, status: response.status, code: data?.code || "unknown" });
    throw new Error(`${operation} failed with ${response.status} ${data?.code || data?.error || ""}`);
  }
  return { response, data };
}

async function login(name) {
  const response = await call("login", "/auth/login", {
    method: "POST",
    body: { whatsapp: name, senha: password },
    expected: [200]
  });
  if (!response.data.token) throw new Error(`Login did not return a token for ${name}`);
  return response.data.token;
}

async function main() {
  const ready = await call("health", "/health/ready", { expected: [200] });
  const tokens = await Promise.all(teams.map(team => login(team.login)));
  const moderatorToken = await login("radar_moderador");
  const availabilityStart = new Date(Date.now() + 3_600_000);
  const availabilityEnd = new Date(availabilityStart.getTime() + 7_200_000);

  await Promise.all(tokens.map(token => call("availability", "/me/time/amistosos/disponibilidades", {
    token,
    method: "POST",
    key: crypto.randomUUID(),
    body: {
      modality: "society",
      category: "Livre",
      starts_at: availabilityStart.toISOString(),
      ends_at: availabilityEnd.toISOString(),
      travel_radius_km: 50,
      venue_preference: "either",
      status: "active"
    }
  })));

  const searches = await Promise.all(tokens.map(token => call(
    "search",
    "/amistosos/times-proximos?modality=society&category=Livre&radius_km=50&limit=5",
    { token, expected: [200] }
  )));
  if (searches.some(result => !result.data.items?.length)) {
    throw new Error("Concurrent staging search returned an empty candidate set");
  }
  const cursor = searches[0].data.page?.next_cursor || searches[0].data.next_cursor;
  if (cursor) {
    await call("pagination", `/amistosos/times-proximos?modality=society&category=Livre&radius_km=50&limit=5&cursor=${encodeURIComponent(cursor)}`, {
      token: tokens[0],
      expected: [200]
    });
  }

  const scheduledAt = new Date(Date.now() + 20_000);
  const scheduledEnd = new Date(scheduledAt.getTime() + 7_200_000);
  const invitations = await Promise.all(Array.from({ length: 15 }, (_, pair) => call(
    "invitation",
    "/amistosos/convites",
    {
      token: tokens[pair * 2],
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        opponent_slug: teams[pair * 2 + 1].slug,
        starts_at: scheduledAt.toISOString(),
        ends_at: scheduledEnd.toISOString(),
        modality: "society",
        category: "Livre",
        venue_preference: "either",
        message: "Carga controlada de staging."
      }
    }
  )));

  const accepted = await Promise.all(invitations.map(async (created, pair) => {
    const invitation = created.data.invitation;
    const idempotencyKey = crypto.randomUUID();
    const route = `/amistosos/convites/${invitation.invitation_id}/aceitar`;
    const options = {
      token: tokens[pair * 2 + 1],
      method: "POST",
      key: idempotencyKey,
      etag: etag(invitation),
      body: {},
      expected: [200]
    };
    const [first, replay] = await Promise.all([
      call("acceptance", route, options),
      call("acceptance_replay", route, options)
    ]);
    const match = first.data.match || replay.data.match;
    if (!match?.match_id) throw new Error("Concurrent acceptance did not return a match");
    return match;
  }));
  if (new Set(accepted.map(match => match.match_id)).size !== 15) {
    throw new Error("Concurrent acceptance created duplicate matches");
  }

  const waitMs = scheduledAt.getTime() - Date.now() + 500;
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  const played = [];
  for (let pair = 0; pair < 5; pair += 1) {
    const matchId = accepted[pair].match_id;
    for (const side of [0, 1]) {
      const token = tokens[pair * 2 + side];
      const current = await call("match_detail", `/me/time/amistosos/${matchId}`, { token, expected: [200] });
      await call("occurrence", `/me/time/amistosos/${matchId}/confirmar-realizacao`, {
        token,
        method: "POST",
        key: crypto.randomUUID(),
        etag: current.response.headers.get("etag"),
        body: {},
        expected: [200]
      });
    }
    played.push(matchId);
  }

  await Promise.all(played.map(async (matchId, pair) => {
    const first = await call("match_detail", `/me/time/amistosos/${matchId}`, {
      token: tokens[pair * 2],
      expected: [200]
    });
    await call("score", `/me/time/amistosos/${matchId}/resultado`, {
      token: tokens[pair * 2],
      method: "POST",
      key: crypto.randomUUID(),
      etag: first.response.headers.get("etag"),
      body: { gols_meu_time: pair + 2, gols_adversario: 1 },
      expected: [200]
    });
    const second = await call("match_detail", `/me/time/amistosos/${matchId}`, {
      token: tokens[pair * 2 + 1],
      expected: [200]
    });
    await call("score_confirmation", `/me/time/amistosos/${matchId}/resultado/confirmar`, {
      token: tokens[pair * 2 + 1],
      method: "POST",
      key: crypto.randomUUID(),
      etag: second.response.headers.get("etag"),
      body: {},
      expected: [200]
    });
  }));

  const reports = await Promise.all(played.slice(0, 3).map((matchId, index) => call(
    "report",
    "/me/time/radar/denuncias",
    {
      token: tokens[index * 2],
      method: "POST",
      key: crypto.randomUUID(),
      body: {
        tipo: "partida",
        match_id: matchId,
        categoria: "unsafe_conduct",
        descricao: "Relato privado de carga de staging."
      }
    }
  )));

  for (const report of reports) {
    const caseId = report.data.case.case_id;
    const queue = await call("moderation", "/admin/radar/moderacao?limit=20", {
      token: moderatorToken,
      expected: [200]
    });
    const item = queue.data.items.find(candidate => candidate.case_id === caseId);
    const assigned = await call("moderation", `/admin/radar/moderacao/${caseId}/atribuir`, {
      token: moderatorToken,
      method: "POST",
      key: crypto.randomUUID(),
      etag: etag(item),
      body: { motivo: "triage" },
      expected: [200]
    });
    await call("moderation", `/admin/radar/moderacao/${caseId}/resolver`, {
      token: moderatorToken,
      method: "POST",
      key: crypto.randomUUID(),
      etag: etag(assigned.data.case),
      body: { decisao: "warn", motivo: "violation_confirmed" },
      expected: [200]
    });
  }

  const report = {
    ok: unexpected.length === 0,
    mode: "isolated-online-staging-load",
    production_targeted: false,
    teams: teams.length,
    availabilities: teams.length,
    concurrent_searches: searches.length,
    invitations: invitations.length,
    unique_matches: new Set(accepted.map(match => match.match_id)).size,
    played_and_scored_matches: played.length,
    reports_moderated: reports.length,
    unexpected_errors: unexpected,
    latency: summarize(),
    migrations: ready.data.migrations || null,
    completed_at: new Date().toISOString()
  };
  if (proofFile) {
    const resolved = path.resolve(proofFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`Radar staging load failed: ${error.message}\n`);
  process.exitCode = 1;
});
