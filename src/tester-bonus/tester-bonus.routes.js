"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function campaignError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

function findCustomerByEmail(value, customers) {
  const email = normalizeEmail(value);
  if (!email) return null;
  const matches = Object.entries(customers || {}).filter(([, customer]) =>
    normalizeEmail(customer?.email) === email);
  if (matches.length > 1) {
    throw campaignError(409, "EMAIL_ACCOUNT_AMBIGUOUS", "Este e-mail esta associado a mais de uma conta. Confira o cadastro antes de liberar o bonus.");
  }
  return matches.length ? { customerKey: matches[0][0], customer: matches[0][1] } : null;
}

// E-mail is an alias for a stable customer key. Never strip '@' and fall back to
// a legacy username: that could select another person's pre-existing account.
function resolveTesterBonusLogin(identifier, customers, normalizeLegacyLogin) {
  const raw = String(identifier || "").trim();
  if (raw.includes("@")) {
    try { return findCustomerByEmail(raw, customers)?.customerKey || null; }
    catch { return null; }
  }
  const key = normalizeLegacyLogin(raw);
  return key && Object.hasOwn(customers || {}, key) ? key : null;
}

function createTemporaryPassword(email) {
  const localPart = (normalizeEmail(email) || "").split("@")[0];
  const readable = localPart.replace(/[^a-z0-9]/gi, "").slice(0, 20);
  const prefix = readable.length >= 2
    ? readable.charAt(0).toUpperCase() + readable.slice(1)
    : "Cliente";
  // Keep the password related to the supplied address without making its
  // variable part predictable. Existing accounts never call this generator.
  const suffix = String(crypto.randomInt(0, 100000000)).padStart(8, "0");
  return prefix + "-" + suffix;
}

function publicAccount(customerKey, customer, created = false) {
  return {
    login: customerKey,
    email: normalizeEmail(customer?.email),
    created,
    login_type: customer?.login_tipo || "password",
    password_change_required: customer?.senha_temporaria === true
  };
}

function createTesterBonusRouter({
  auth,
  isBotAdmin,
  readClientes,
  writeClientes,
  store,
  bcrypt = require("bcryptjs"),
  normalizarLoginId,
  dataDir,
  nowYYYYMM = () => new Date().toISOString().slice(0, 7),
  express = require("express")
}) {
  if (![auth, isBotAdmin, readClientes, writeClientes, normalizarLoginId].every(value => typeof value === "function") ||
      !store || typeof store.grant !== "function" || typeof store.getSummary !== "function" || !dataDir) {
    throw new TypeError("Dependencias do cadastro de testadores incompletas.");
  }
  const router = express.Router();
  const lockPath = path.join(dataDir, "tester-bonus-accounts.lock");
  fs.mkdirSync(dataDir, { recursive: true });

  // Campaign provisioning is serialized across processes. Existing legacy
  // customer writers must still be migrated to a shared transaction separately.
  async function withAccountsLock(operation) {
    const deadline = Date.now() + 3000;
    let handle;
    while (!handle) {
      try { handle = await fs.promises.open(lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST" && !(process.platform === "win32" && error.code === "EPERM")) throw error;
        if (Date.now() >= deadline) throw campaignError(409, "TESTER_ACCOUNT_BUSY", "Cadastro em andamento. Tente novamente em alguns segundos.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); }
    finally {
      await handle.close();
      await fs.promises.unlink(lockPath).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  function requireAdmin(req, res, next) {
    if (!isBotAdmin(req)) return res.status(403).json({ ok: false, code: "ADMIN_REQUIRED", error: "Acesso negado." });
    res.setHeader("Cache-Control", "private, no-store");
    next();
  }

  function respondError(res, error) {
    return res.status(error.status || 503).json({
      ok: false,
      code: error.code || "TESTER_BONUS_UNAVAILABLE",
      error: error.status ? error.message : "Nao foi possivel concluir a operacao agora."
    });
  }

  router.post("/admin/tester-bonus/grant", auth, requireAdmin, async (req, res) => {
    try {
      const result = await withAccountsLock(async () => {
        const body = req.body || {};
        const loginInput = String(body.login || "").trim();
        const emailInput = body.email || (loginInput.includes("@") ? loginInput : "");
        const email = emailInput ? normalizeEmail(emailInput) : null;
        if (emailInput && !email) throw campaignError(400, "INVALID_EMAIL", "Informe um e-mail valido.");
        if (!loginInput && !email) throw campaignError(400, "CUSTOMER_REQUIRED", "Informe o login existente ou o e-mail do participante.");
        const customers = readClientes();
        const emailMatch = email ? findCustomerByEmail(email, customers) : null;
        const loginKey = loginInput ? resolveTesterBonusLogin(loginInput, customers, normalizarLoginId) : null;
        if (emailMatch && loginKey && emailMatch.customerKey !== loginKey) {
          throw campaignError(409, "EMAIL_ACCOUNT_CONFLICT", "O e-mail e o login pertencem a contas diferentes.");
        }
        let customerKey = emailMatch?.customerKey || loginKey;
        let customer = customerKey ? customers[customerKey] : null;
        let created = false;
        let password;
        if (!customer) {
          if (body.create_account !== true) throw campaignError(404, "ACCOUNT_NOT_FOUND", "Conta nao encontrada. Autorize a criacao de uma conta nova para este e-mail.");
          if (!email) throw campaignError(400, "EMAIL_REQUIRED", "Informe o e-mail para criar uma conta nova.");
          do { customerKey = "tester_" + crypto.randomBytes(12).toString("hex"); }
          while (Object.hasOwn(customers, customerKey));
          password = createTemporaryPassword(email);
          customer = {
            nome_time: String(body.nome_time || email.split("@")[0]).trim().slice(0, 120),
            email,
            email_verified: false,
            senha_hash: bcrypt.hashSync(password, 12),
            senha_temporaria: true,
            login_tipo: "tester_password",
            tester_bonus_customer_key: customerKey,
            tester_bonus_grant_pending: true,
            plano: 0,
            saldo_mensal: 0,
            saldo_extra: 0,
            usados_no_ciclo: 0,
            ciclo_mes: nowYYYYMM(),
            ativo: true,
            criado_em: new Date().toISOString()
          };
          created = true;
        } else {
          if (customer.ativo !== true) throw campaignError(409, "ACCOUNT_INACTIVE", "A conta esta inativa. Confira o cadastro antes de liberar o bonus.");
          const storedEmail = normalizeEmail(customer.email);
          if (email && storedEmail && storedEmail !== email) throw campaignError(409, "EMAIL_ACCOUNT_CONFLICT", "O login ja possui outro e-mail cadastrado.");
          // A completed grant must not silently become a fresh five-image grant
          // after ledger loss. Only an explicitly pending first grant may retry.
          if (customer.tester_bonus_customer_key && customer.tester_bonus_grant_pending !== true &&
              store.getSummary(customer.tester_bonus_customer_key).granted !== true) {
            throw campaignError(503, "TESTER_BONUS_GRANT_MISSING", "O registro do bonus esta indisponivel. Confira os dados antes de liberar novamente.");
          }
          // Only an authenticated administrator may attach the supplied e-mail;
          // it is never considered verified merely because it was submitted.
          if (email && !storedEmail) {
            customer.email = email;
            customer.email_verified = false;
          }
          if (!customer.tester_bonus_customer_key) {
            customer.tester_bonus_customer_key = customerKey;
            customer.tester_bonus_grant_pending = true;
          }
        }
        customers[customerKey] = customer;
        writeClientes(customers);
        const account = publicAccount(customerKey, customer, created);
        const credentials = created ? { login: email, email, password } : undefined;
        try {
          const grant = await store.grant({
            customerKey: customer.tester_bonus_customer_key,
            actor: req.user.whatsapp,
            ...(body.campaign_id ? { campaignId: String(body.campaign_id).slice(0, 80) } : {})
          });
          const refreshed = readClientes();
          const currentCustomer = refreshed[customerKey];
          if (!currentCustomer || currentCustomer.tester_bonus_customer_key !== customer.tester_bonus_customer_key) {
            throw campaignError(503, "TESTER_BONUS_ACCOUNT_CHANGED", "O cadastro mudou durante a liberacao. Confira a conta antes de continuar.");
          }
          currentCustomer.tester_bonus_grant_pending = false;
          currentCustomer.tester_bonus_grant_id = grant.grantId;
          currentCustomer.tester_bonus_granted_em = currentCustomer.tester_bonus_granted_em || new Date().toISOString();
          writeClientes(refreshed);
          return {
            status: created ? 201 : 200,
            body: {
              ok: true,
              account,
              bonus: grant.summary || store.getSummary(customer.tester_bonus_customer_key),
              grant: { replayed: grant.replayed === true, grantId: grant.grantId, campaignId: grant.campaignId },
              ...(credentials ? { credentials } : {})
            }
          };
        } catch (error) {
          if (!created) throw error;
          let summary = null;
          try { summary = store.getSummary(customer.tester_bonus_customer_key); }
          catch { /* Preserve the one-time credentials even if quota is unreadable. */ }
          // Account storage and quota storage are distinct. If quota fails after
          // creating the account, deliver the new credentials once and explicitly
          // report pending quota rather than silently losing the only password.
          return {
            status: 201,
            body: {
              ok: true,
              account,
              credentials,
              bonus_pending: true,
              bonus_error: "A conta foi criada, mas a liberacao do bonus ficou pendente. Repita a liberacao para esta conta.",
              bonus: summary
            }
          };
        }
      });
      return res.status(result.status).json(result.body);
    } catch (error) { return respondError(res, error); }
  });

  router.get("/admin/tester-bonus/:login", auth, requireAdmin, (req, res) => {
    try {
      const customers = readClientes();
      const customerKey = resolveTesterBonusLogin(req.params.login, customers, normalizarLoginId);
      if (!customerKey) throw campaignError(404, "ACCOUNT_NOT_FOUND", "Conta nao encontrada.");
      const customer = customers[customerKey];
      const bonus = store.getSummary(customer.tester_bonus_customer_key || customerKey);
      if (customer.tester_bonus_customer_key && bonus.granted !== true) {
        throw campaignError(503, "TESTER_BONUS_GRANT_MISSING", "O registro do bonus esta indisponivel. Confira os dados antes de continuar.");
      }
      return res.json({ ok: true, account: publicAccount(customerKey, customer), bonus });
    } catch (error) { return respondError(res, error); }
  });

  router.post("/auth/change-password", auth, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const currentPassword = String(req.body?.current_password || "");
      const newPassword = String(req.body?.new_password || "");
      if (!currentPassword || newPassword.length < 10 || newPassword.length > 128) {
        throw campaignError(400, "INVALID_PASSWORD", "Informe a senha atual e uma nova senha com pelo menos 10 caracteres.");
      }
      if (Buffer.byteLength(newPassword, "utf8") > 72) throw campaignError(400, "PASSWORD_TOO_LONG", "A nova senha e muito longa. Use uma senha mais curta.");
      if (currentPassword === newPassword) throw campaignError(400, "PASSWORD_UNCHANGED", "Escolha uma senha diferente da atual.");
      await withAccountsLock(async () => {
        const customers = readClientes();
        const customerKey = String(req.user?.whatsapp || "");
        const customer = customers[customerKey];
        if (!customer || customer.ativo !== true) throw campaignError(403, "ACCOUNT_UNAVAILABLE", "Conta indisponivel.");
        if (!customer.senha_hash) throw campaignError(400, "PASSWORD_AUTH_UNAVAILABLE", "Esta conta utiliza entrada pelo Google.");
        if (!bcrypt.compareSync(currentPassword, customer.senha_hash)) throw campaignError(401, "CURRENT_PASSWORD_INVALID", "Senha atual incorreta.");
        customer.senha_hash = bcrypt.hashSync(newPassword, 12);
        customer.senha_temporaria = false;
        customer.senha_atualizada_em = new Date().toISOString();
        writeClientes(customers);
      });
      return res.json({ ok: true, senha_temporaria: false });
    } catch (error) { return respondError(res, error); }
  });

  return router;
}

module.exports = {
  createTesterBonusRouter,
  resolveTesterBonusLogin,
  findCustomerByEmail,
  normalizeEmail,
  createTemporaryPassword
};
