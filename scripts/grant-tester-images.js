#!/usr/bin/env node
"use strict";

// Run inside the existing service's authorized Shell. Uses only loopback HTTP;
// it never exports the service's signing key or administrative session.
const jwt = require("jsonwebtoken");
const { readJwtSecret } = require("../src/config/auth");
const { normalizeEmail } = require("../src/tester-bonus/tester-bonus.routes");

async function grantTesterAccount({ email, env = process.env, fetchImpl = fetch } = {}) {
  const address = normalizeEmail(email);
  if (!address) throw new Error("Informe um e-mail valido.");
  const port = Number(env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A porta local do servico e invalida.");
  const administrator = String(env.BOT_ADMIN_WHATSAPP || "15991120599").trim();
  const session = jwt.sign({ whatsapp: administrator }, readJwtSecret(env), { expiresIn: "2m" });
  const origin = "http://127.0.0.1:" + port;
  async function request(endpoint, body, token = session) {
    const response = await fetchImpl(origin + endpoint, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(data.error || "Nao foi possivel concluir a operacao administrativa.");
    return data;
  }
  const result = await request("/admin/tester-bonus/grant", { login: address, create_account: true });
  if (result.bonus_pending === true) return { ...result, email: address, verified: false };
  try {
    let verification;
    if (result.account?.created === true && result.credentials?.password) {
      const login = await request("/auth/login", { whatsapp: address, senha: result.credentials.password });
      if (!login.token) throw new Error("O novo acesso nao foi confirmado.");
      verification = await request("/me", null, login.token);
      verification = verification.tester_image_bonus;
    } else {
      verification = (await request("/admin/tester-bonus/" + encodeURIComponent(address))).bonus;
    }
    if (verification?.granted !== true || verification.limit !== 5 ||
        verification.grantId !== result.bonus?.grantId) throw new Error("A cota nao foi confirmada.");
    return { ...result, email: address, bonus: verification, verified: true };
  } catch {
    // A new password is delivered only once: preserve it in the operator's
    // response even if a subsequent verification is temporarily unavailable.
    return { ...result, email: address, verified: false,
      verification_error: "A operacao respondeu, mas a verificacao final ficou pendente. Guarde o acesso exibido e consulte a cota antes de repetir." };
  }
}

if (require.main === module) {
  grantTesterAccount({ email: process.argv[2] }).then(result => {
    console.log("Login: " + result.email);
    if (result.account?.created && result.credentials?.password) console.log("Senha temporaria: " + result.credentials.password);
    else console.log(result.account?.login_type === "google" ? "Conta existente: continue entrando com Google." : "Conta existente: senha preservada.");
    if (result.verified) console.log("Artes gratis disponiveis: " + result.bonus.remaining + " de 5.");
    else { console.log(result.bonus_error || result.verification_error || "Liberacao pendente."); process.exitCode = 2; }
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { grantTesterAccount };

