"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { createTesterBonusRouter, resolveTesterBonusLogin, findCustomerByEmail, createTemporaryPassword } = require("./src/tester-bonus/tester-bonus.routes");

const normalizeLegacyLogin = value => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9._-]+/g, "");

test("temporary passwords use a readable email prefix with eight random digits and a safe fallback", () => {
  assert.match(createTemporaryPassword("clube@example.com"), /^Clube-\d{8}$/);
  assert.match(createTemporaryPassword(" Clube.Social+teste@example.com "), /^Clubesocialteste-\d{8}$/);
  for (const email of ["a@example.com", "!!!@example.com", "", undefined]) {
    const password = createTemporaryPassword(email);
    assert.match(password, /^Cliente-\d{8}$/);
    assert.ok(password.length >= 10);
  }
  const longLocalPart = createTemporaryPassword("abcdefghijklmnopqrstuvwxyz@example.com");
  assert.match(longLocalPart, /^Abcdefghijklmnopqrst-\d{8}$/);
  assert.ok(Buffer.byteLength(longLocalPart, "utf8") <= 72);
});

test("the numeric password suffix comes from the cryptographic random source and preserves leading zeros", t => {
  const random = t.mock.method(crypto, "randomInt", (minimum, maximum) => {
    assert.equal(minimum, 0);
    assert.equal(maximum, 100000000);
    return 1234;
  });
  const password = createTemporaryPassword("clube@example.com");
  assert.equal(password.split("-")[1], "00001234");
  assert.equal(random.mock.callCount(), 1);
});

async function fixture(t, initialCustomers = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-tester-auth-"));
  let customers = structuredClone(initialCustomers);
  const grants = new Map();
  const faults = { grant: false, summary: false };
  const store = {
    getSummary(customerKey) {
      if (faults.summary) throw new Error("quota unavailable");
      return grants.has(customerKey)
        ? { granted: true, limit: 5, remaining: 5, available: 5, used: 0, reserved: 0, active: true }
        : { granted: false, limit: 5, remaining: 0, available: 0, used: 0, reserved: 0, active: false };
    },
    async grant({ customerKey, campaignId = "testers" }) {
      if (faults.grant) throw new Error("quota unavailable");
      const replayed = grants.has(customerKey);
      grants.set(customerKey, true);
      return { granted: true, replayed, grantId: "grant:" + customerKey, campaignId, summary: store.getSummary(customerKey) };
    }
  };
  const router = createTesterBonusRouter({
    auth(req, res, next) {
      const user = req.headers["x-test-user"];
      if (!user) return res.status(401).json({ ok: false });
      req.user = { whatsapp: user };
      next();
    },
    isBotAdmin: req => req.user.whatsapp === "admin",
    readClientes: () => structuredClone(customers),
    writeClientes: value => { customers = structuredClone(value); },
    store,
    bcrypt,
    normalizarLoginId: normalizeLegacyLogin,
    dataDir,
    nowYYYYMM: () => "2026-11"
  });
  t.after(() => fs.rmdirSync(dataDir));
  return {
    customers: () => structuredClone(customers),
    grants,
    faults,
    async request(route, body, user = "admin", method = "POST") {
      return await new Promise((resolve, reject) => {
        const headers = {};
        const req = { method, url: route, headers: user ? { "x-test-user": user } : {}, body: body || {} };
        const res = {
          statusCode: 200,
          setHeader(name, value) { headers[name.toLowerCase()] = value; },
          getHeader(name) { return headers[name.toLowerCase()]; },
          status(value) { this.statusCode = value; return this; },
          json(value) { resolve({ status: this.statusCode, cache: headers["cache-control"] || null, body: value }); return this; }
        };
        router.handle(req, res, error => error ? reject(error) : resolve({ status: 404, body: {} }));
      });
    }
  };
}

test("only an authenticated administrator can create an account or grant images", async t => {
  const f = await fixture(t);
  const body = { email: "new@gmail.com", create_account: true };
  assert.equal((await f.request("/admin/tester-bonus/grant", body, null)).status, 401);
  assert.equal((await f.request("/admin/tester-bonus/grant", body, "ordinary")).status, 403);
  assert.deepEqual(f.customers(), {});
  assert.equal(f.grants.size, 0);
});

test("creating a new email account requires explicit creation and a valid email", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/admin/tester-bonus/grant", { email: "new@gmail.com" })).status, 404);
  assert.equal((await f.request("/admin/tester-bonus/grant", { email: "invalid", create_account: true })).status, 400);
  assert.equal((await f.request("/admin/tester-bonus/grant", { login: "missing", create_account: true })).status, 400);
  assert.deepEqual(f.customers(), {});
});

test("new tester gets Gmail login, hashed random temporary password and exactly one five-image grant", async t => {
  const f = await fixture(t);
  const response = await f.request("/admin/tester-bonus/grant", { email: " Person@gmail.com ", create_account: true });
  assert.equal(response.status, 201);
  assert.match(response.cache, /no-store/);
  const { account, credentials, bonus } = response.body;
  assert.equal(account.email, "person@gmail.com");
  assert.equal(credentials.login, "person@gmail.com");
  assert.match(credentials.password, /^Person-\d{8}$/);
  assert.ok(credentials.password.length >= 10);
  assert.equal(bonus.limit, 5);
  assert.equal(bonus.remaining, 5);
  assert.equal(response.body.token, undefined);
  const customers = f.customers();
  const customer = customers[account.login];
  assert.match(account.login, /^tester_[0-9a-f]{24}$/);
  assert.equal(customer.senha_temporaria, true);
  assert.equal(customer.email_verified, false);
  assert.equal(customer.saldo_extra, 0);
  assert.ok(bcrypt.compareSync(credentials.password, customer.senha_hash));
  assert.ok(!JSON.stringify(customers).includes(credentials.password));
  assert.equal(resolveTesterBonusLogin("Person@Gmail.com", customers, normalizeLegacyLogin), account.login);
  const repeat = await f.request("/admin/tester-bonus/grant", { email: "person@gmail.com", create_account: true });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.grant.replayed, true);
  assert.equal(repeat.body.credentials, undefined);
  assert.deepEqual(f.customers()[account.login], customer);
  assert.equal(f.grants.size, 1);
});

test("concurrent duplicate submissions preserve one account, one grant and one credential response", async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.request("/admin/tester-bonus/grant", { email: "same@gmail.com", create_account: true })));
  assert.equal(responses.filter(response => response.body.credentials).length, 1);
  assert.equal(Object.keys(f.customers()).length, 1);
  assert.equal(f.grants.size, 1);
  assert.deepEqual(responses.map(response => response.body.bonus.remaining), [5, 5, 5, 5]);
});

test("existing Google identity is reused without assigning a password or replacing customer data", async t => {
  const existing = { email: "google@gmail.com", login_tipo: "google", senha_hash: "", ativo: true, saldo_extra: 17, perfil_id: "existing-profile" };
  const f = await fixture(t, { google_123: existing });
  const response = await f.request("/admin/tester-bonus/grant", { email: "GOOGLE@gmail.com", create_account: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.account.login, "google_123");
  assert.equal(response.body.account.login_type, "google");
  assert.equal(response.body.credentials, undefined);
  assert.equal(f.customers().google_123.senha_hash, "");
  assert.equal(f.customers().google_123.saldo_extra, 17);
  assert.equal(f.customers().google_123.perfil_id, "existing-profile");
  const passwordResponse = await f.request("/auth/change-password", { current_password: "anything", new_password: "NewPassword123" }, "google_123");
  assert.equal(passwordResponse.status, 400);
  assert.equal(passwordResponse.body.code, "PASSWORD_AUTH_UNAVAILABLE");
});

test("conflicting login/email and ambiguous email identities fail without changing existing accounts", async t => {
  const initial = { a: { email: "a@gmail.com", ativo: true }, b: { email: "b@gmail.com", ativo: true } };
  const f = await fixture(t, initial);
  const response = await f.request("/admin/tester-bonus/grant", { login: "a", email: "b@gmail.com" });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "EMAIL_ACCOUNT_CONFLICT");
  assert.deepEqual(f.customers(), initial);
  assert.equal(f.grants.size, 0);
  const duplicates = { a: { email: "duplicate@gmail.com" }, b: { email: "DUPLICATE@gmail.com" } };
  assert.throws(() => findCustomerByEmail("duplicate@gmail.com", duplicates), { code: "EMAIL_ACCOUNT_AMBIGUOUS" });
  assert.equal(resolveTesterBonusLogin("duplicate@gmail.com", duplicates, normalizeLegacyLogin), null);
});

test("email lookup never falls back to a legacy username formed by stripping @", () => {
  const customers = { "personexample.com": { ativo: true }, olduser: { ativo: true } };
  assert.equal(resolveTesterBonusLogin("person@example.com", customers, normalizeLegacyLogin), null);
  assert.equal(resolveTesterBonusLogin(" OLDUSER ", customers, normalizeLegacyLogin), "olduser");
});

test("quota failure after account creation explicitly returns pending and preserves one-time credentials", async t => {
  const f = await fixture(t);
  f.faults.grant = true;
  f.faults.summary = true;
  const created = await f.request("/admin/tester-bonus/grant", { email: "pending@gmail.com", create_account: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.bonus_pending, true);
  assert.equal(created.body.bonus, null);
  const customerKey = created.body.account.login;
  const previousHash = f.customers()[customerKey].senha_hash;
  assert.ok(bcrypt.compareSync(created.body.credentials.password, previousHash));
  f.faults.grant = false;
  f.faults.summary = false;
  const retry = await f.request("/admin/tester-bonus/grant", { login: customerKey });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.credentials, undefined);
  assert.equal(retry.body.bonus.remaining, 5);
  assert.equal(f.customers()[customerKey].senha_hash, previousHash);
  assert.equal(f.customers()[customerKey].tester_bonus_grant_pending, false);
});

test("a completed grant with a missing ledger cannot be recreated or reported as an unused allowance", async t => {
  const f = await fixture(t);
  const created = await f.request("/admin/tester-bonus/grant", { email: "lost@gmail.com", create_account: true });
  const key = created.body.account.login;
  assert.equal(f.customers()[key].tester_bonus_grant_pending, false);
  f.grants.clear();
  const originalCustomers = f.customers();
  const repeated = await f.request("/admin/tester-bonus/grant", { email: "lost@gmail.com", create_account: true });
  assert.equal(repeated.status, 503);
  assert.equal(repeated.body.code, "TESTER_BONUS_GRANT_MISSING");
  assert.equal(f.grants.size, 0);
  assert.deepEqual(f.customers(), originalCustomers);
  const lookup = await f.request("/admin/tester-bonus/" + encodeURIComponent(key), null, "admin", "GET");
  assert.equal(lookup.status, 503);
});

test("password change requires the current password and preserves customer key, balance and grant", async t => {
  const f = await fixture(t);
  const created = await f.request("/admin/tester-bonus/grant", { email: "change@gmail.com", create_account: true });
  const { account, credentials } = created.body;
  const payload = { current_password: credentials.password, new_password: "UpdatedPassword123" };
  assert.equal((await f.request("/auth/change-password", { ...payload, current_password: "incorrect" }, account.login)).status, 401);
  assert.equal((await f.request("/auth/change-password", { ...payload, new_password: "short" }, account.login)).status, 400);
  assert.equal((await f.request("/auth/change-password", { ...payload, new_password: "a".repeat(73) }, account.login)).status, 400);
  const response = await f.request("/auth/change-password", payload, account.login);
  assert.equal(response.status, 200);
  assert.equal(response.body.senha_temporaria, false);
  const customer = f.customers()[account.login];
  assert.equal(customer.senha_temporaria, false);
  assert.equal(customer.saldo_extra, 0);
  assert.ok(bcrypt.compareSync(payload.new_password, customer.senha_hash));
  assert.ok(!bcrypt.compareSync(credentials.password, customer.senha_hash));
  assert.equal(f.grants.size, 1);
  const summary = await f.request("/admin/tester-bonus/" + encodeURIComponent("change@gmail.com"), null, "admin", "GET");
  assert.equal(summary.status, 200);
  assert.equal(summary.body.credentials, undefined);
  assert.equal(summary.body.bonus.remaining, 5);
});
