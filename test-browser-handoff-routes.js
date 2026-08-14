const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-handoff-routes-"));
const handoffFile = path.join(testDataDir, "auth_browser_handoffs.json");
const jwtSecret = "browser-handoff-route-test-secret";

process.env.OMASCOTE_DATA_DIR = testDataDir;
process.env.AUTH_BROWSER_HANDOFF_FILE = handoffFile;
delete process.env.AUTH_BROWSER_HANDOFF_ENABLED;
process.env.JWT_SECRET = jwtSecret;
process.env.NODE_ENV = "test";

fs.mkdirSync(testDataDir, { recursive: true });
fs.writeFileSync(path.join(testDataDir, "clientes.json"), JSON.stringify({
  handoff_user: {
    nome_time: "Time Handoff",
    ativo: true,
    cadastro_automatico: true,
    conta_finalizada: false,
    plano: 0,
    saldo_mensal: 2,
    saldo_extra: 3,
    usados_no_ciclo: 1,
    ciclo_mes: "2026-08"
  },
  inactive_user: {
    nome_time: "Time Inativo",
    ativo: false,
    plano: 0,
    saldo_mensal: 0,
    saldo_extra: 0,
    usados_no_ciclo: 0,
    ciclo_mes: "2026-08"
  },
  becomes_inactive_user: {
    nome_time: "Time Sera Inativo",
    ativo: true,
    plano: 0,
    saldo_mensal: 0,
    saldo_extra: 0,
    usados_no_ciclo: 0,
    ciclo_mes: "2026-08"
  },
  missing_after_issue_user: {
    nome_time: "Time Sera Removido",
    ativo: true,
    plano: 0,
    saldo_mensal: 0,
    saldo_extra: 0,
    usados_no_ciclo: 0,
    ciclo_mes: "2026-08"
  }
}, null, 2), "utf8");

const { app } = require("./server");

function bearer(userId) {
  return `Bearer ${jwt.sign({ whatsapp: userId }, jwtSecret, { expiresIn: "5m" })}`;
}

function headers(extra = {}) {
  return {
    Origin: "https://omascote.com.br",
    "Content-Type": "application/json",
    "X-Forwarded-For": "203.0.113.20",
    ...extra
  };
}

async function json(response) {
  return response.json().catch(() => ({}));
}

test("browser handoff routes are gated, strict, one-time and rate limited", async t => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authHeader = bearer("handoff_user");
  const sourceClaims = jwt.verify(authHeader.slice("Bearer ".length), jwtSecret);

  const disabledIssue = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({ Authorization: authHeader }),
    body: "{}"
  });
  assert.equal(disabledIssue.status, 404);

  const disabledRedeem = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ code: "A".repeat(43) })
  });
  assert.equal(disabledRedeem.status, 404);
  assert.equal(fs.existsSync(handoffFile), false);

  process.env.AUTH_BROWSER_HANDOFF_ENABLED = "true";
  for (const unsafeValue of ["", "TROQUE_ISSO_AGORA"]) {
    process.env.JWT_SECRET = unsafeValue;
    const unsafeSecret = await fetch(`${baseUrl}/auth/browser-handoff`, {
      method: "POST",
      headers: headers({ Authorization: authHeader }),
      body: "{}"
    });
    assert.equal(unsafeSecret.status, 503);
    assert.equal(fs.existsSync(handoffFile), false);
  }
  process.env.JWT_SECRET = jwtSecret;

  const oversized = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ code: "A".repeat(3_000) })
  });
  assert.equal(oversized.status, 413);
  assert.equal(fs.existsSync(handoffFile), false);

  const malformedJson = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers(),
    body: "{\"code\":"
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(fs.existsSync(handoffFile), false);

  const malformedCode = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ code: "curto" })
  });
  assert.equal(malformedCode.status, 400);
  assert.equal(fs.existsSync(handoffFile), false);

  const forbiddenOrigin = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({
      Authorization: authHeader,
      Origin: "https://example.com"
    }),
    body: "{}"
  });
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal(fs.existsSync(handoffFile), false);

  const noAuth = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers(),
    body: "{}"
  });
  assert.equal(noAuth.status, 401);

  const inactive = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({ Authorization: bearer("inactive_user") }),
    body: "{}"
  });
  assert.equal(inactive.status, 403);

  const missingAccount = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({ Authorization: bearer("missing_user") }),
    body: "{}"
  });
  assert.equal(missingAccount.status, 403);

  const issueBecomesInactive = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({
      Authorization: bearer("becomes_inactive_user"),
      "X-Forwarded-For": "203.0.113.21"
    }),
    body: "{}"
  });
  const becomesInactiveData = await json(issueBecomesInactive);
  assert.equal(issueBecomesInactive.status, 201);

  const clientesAfterInactiveIssue = JSON.parse(
    fs.readFileSync(path.join(testDataDir, "clientes.json"), "utf8")
  );
  clientesAfterInactiveIssue.becomes_inactive_user.ativo = false;
  fs.writeFileSync(
    path.join(testDataDir, "clientes.json"),
    JSON.stringify(clientesAfterInactiveIssue, null, 2),
    "utf8"
  );
  const inactiveRedeem = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers({ "X-Forwarded-For": "203.0.113.21" }),
    body: JSON.stringify({ code: becomesInactiveData.handoff_code })
  });
  assert.equal(inactiveRedeem.status, 403);

  const issueBecomesMissing = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({
      Authorization: bearer("missing_after_issue_user"),
      "X-Forwarded-For": "203.0.113.22"
    }),
    body: "{}"
  });
  const becomesMissingData = await json(issueBecomesMissing);
  assert.equal(issueBecomesMissing.status, 201);

  const clientesAfterMissingIssue = JSON.parse(
    fs.readFileSync(path.join(testDataDir, "clientes.json"), "utf8")
  );
  delete clientesAfterMissingIssue.missing_after_issue_user;
  fs.writeFileSync(
    path.join(testDataDir, "clientes.json"),
    JSON.stringify(clientesAfterMissingIssue, null, 2),
    "utf8"
  );
  const missingRedeem = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers({ "X-Forwarded-For": "203.0.113.22" }),
    body: JSON.stringify({ code: becomesMissingData.handoff_code })
  });
  assert.equal(missingRedeem.status, 403);

  const issueResponse = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({ Authorization: authHeader }),
    body: "{}"
  });
  const issueData = await json(issueResponse);
  assert.equal(issueResponse.status, 201);
  assert.equal(issueResponse.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(issueResponse.headers.get("referrer-policy"), "no-referrer");
  assert.match(issueData.handoff_code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issueData.expires_in, 180);

  const persisted = fs.readFileSync(handoffFile, "utf8");
  assert.equal(persisted.includes(issueData.handoff_code), false);
  assert.equal(persisted.includes(authHeader), false);

  const wrongContentType = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: {
      Origin: "https://omascote.com.br",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ code: issueData.handoff_code })
  });
  assert.equal(wrongContentType.status, 415);

  const concurrent = await Promise.all([
    fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ code: issueData.handoff_code })
    }),
    fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ code: issueData.handoff_code })
    })
  ]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 410]);

  const successResponse = concurrent.find(response => response.status === 200);
  const successData = await json(successResponse);
  assert.equal(successResponse.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(successResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(successData.ok, true);
  assert.equal(successData.whatsapp, "handoff_user");
  assert.equal(successData.nome_time, "Time Handoff");
  assert.equal(successData.plano, 0);
  assert.equal(successData.conta_auto_pendente, true);
  assert.equal(successData.usados_no_ciclo, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(successData, "senha"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(successData, "senha_hash"), false);
  const resumedClaims = jwt.verify(successData.token, jwtSecret);
  assert.equal(resumedClaims.whatsapp, "handoff_user");
  assert.ok(resumedClaims.exp <= sourceClaims.exp);
  assert.ok(resumedClaims.exp > Math.floor(Date.now() / 1000));

  const meResponse = await fetch(`${baseUrl}/me`, {
    headers: { Authorization: `Bearer ${successData.token}` }
  });
  assert.equal(meResponse.status, 200);

  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`${baseUrl}/auth/browser-handoff`, {
      method: "POST",
      headers: headers({
        Authorization: authHeader,
        "X-Forwarded-For": `203.0.113.${30 + index}`
      }),
      body: "{}"
    });
    assert.equal(response.status, 201);
  }

  const rateLimited = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({
      Authorization: authHeader,
      "X-Forwarded-For": "203.0.113.40"
    }),
    body: "{}"
  });
  assert.equal(rateLimited.status, 429);
  assert.ok(Number(rateLimited.headers.get("retry-after")) > 0);

  fs.writeFileSync(handoffFile, "{corrompido", "utf8");
  const unavailable = await fetch(`${baseUrl}/auth/browser-handoff`, {
    method: "POST",
    headers: headers({
      Authorization: bearer("inactive_user"),
      "X-Forwarded-For": "203.0.113.50"
    }),
    body: "{}"
  });
  assert.equal(unavailable.status, 403);

  const storageUnavailable = await fetch(`${baseUrl}/auth/browser-handoff/redeem`, {
    method: "POST",
    headers: headers({ "X-Forwarded-For": "203.0.113.51" }),
    body: JSON.stringify({ code: "B".repeat(43) })
  });
  assert.equal(storageUnavailable.status, 503);
});
