"use strict";

const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");

const clean = (value, limit = 180) => String(value ?? "").trim().slice(0, limit);
const fold = value => clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const money = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 100) / 100 : null;
const day = date => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const validId = value => /^[a-zA-Z0-9_-]{1,120}$/.test(value);

function payment(order) {
  const method = clean(order.pagamento_metodo);
  const info = order.pagamento_info || {};
  if (order.bonus_testador_cota_devolvida || order.plano_cota_devolvida || ["refunded", "charged_back"].includes(order.mp_payment_status)) {
    return { tipo: "devolvido", rotulo: "Devolvido / estornado", valor: null };
  }
  if (order.pagamento_pendente === true) return { tipo: "pendente", rotulo: "Pagamento pendente", valor: money(order.valor_pendente) };
  if (method === "bonus_testador") return { tipo: "gratis", rotulo: "Arte grátis · bônus", valor: 0 };
  if (order.brinde_escudo_login === true || order.brinde_escudo3d_app === true || order.brinde_mascote === true || method === "brinde") {
    return { tipo: "gratis", rotulo: "Arte grátis · brinde", valor: 0 };
  }
  if (method === "cupom" && Number(order.valor_final) === 0) return { tipo: "gratis", rotulo: "Arte grátis · cupom", valor: 0 };
  if (method === "plano_semanal") return { tipo: "plano", rotulo: "Coberto pelo plano", valor: null };
  const confirmed = Boolean(order.pagamento_confirmado_em) || info.status === "approved" || order.mp_payment_status === "approved";
  if (confirmed && (method === "pix" || info.origem === "mercado_pago_pix" || order.mp_payment_status === "approved")) {
    return { tipo: "pago", rotulo: "Pago · Pix", valor: money(info.valor_pago ?? order.valor_final ?? order.valor_original) };
  }
  if (confirmed && (method === "saldo_ia4tube" || info.origem === "saldo")) {
    return { tipo: "pago", rotulo: "Pago · saldo", valor: money(info.valor_pago ?? order.valor_final ?? order.valor_original) };
  }
  if (confirmed && Number(info.valor_pago) > 0) return { tipo: "pago", rotulo: "Pagamento confirmado", valor: money(info.valor_pago) };
  return { tipo: "nao_informado", rotulo: "Pagamento não informado", valor: null };
}

function statusOf(raw, imageReady, videoRequested, videoReady) {
  const value = fold(raw).replace(/\s+/g, "_");
  if (/erro|error|falha|failed/.test(value)) return { tipo: "erro", rotulo: "Erro" };
  if (/cancel|expir/.test(value)) return { tipo: "cancelado", rotulo: "Cancelado / expirado" };
  if (/pagamento|aguardando_pix/.test(value)) return { tipo: "aguardando_pagamento", rotulo: "Aguardando pagamento" };
  if (value === "pronto" || value === "concluido") {
    if (!imageReady) return { tipo: "sem_imagem", rotulo: "Resultado indisponível" };
    if (videoRequested && !videoReady) return { tipo: "gerando", rotulo: "Imagem pronta · vídeo pendente" };
    return { tipo: "pronto", rotulo: "Pronto" };
  }
  if (/producao|gerando|process|analise|ajuste/.test(value)) return { tipo: "gerando", rotulo: "Em produção" };
  if (imageReady && (!videoRequested || videoReady)) return { tipo: "pronto", rotulo: "Pronto" };
  return { tipo: "fila", rotulo: "Na fila" };
}

async function directories(base) {
  try { return (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function exists(file) {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function mapLimit(items, limit, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  }));
}

function filters(query, now) {
  for (const key of ["ate", "desde", "status", "pagamento", "busca", "produto", "pagina", "limite"]) {
    if (query[key] !== undefined && typeof query[key] !== "string") throw new Error("Filtro inválido.");
  }
  const to = clean(query.ate || day(now), 32);
  const from = clean(query.desde || day(new Date(now.getTime() - 6 * 86400000)), 32);
  const timestamp = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T12:00:00Z")) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
  if (!timestamp(from) || !timestamp(to)) throw new Error("Informe datas válidas.");
  const start = Date.parse(from + "T00:00:00-03:00"), end = Date.parse(to + "T00:00:00-03:00") + 86400000;
  if (end <= start || end - start > 366 * 86400000) throw new Error("Escolha um período de até 366 dias, com a data inicial antes da final.");
  const statuses = ["", "fila", "gerando", "pronto", "erro", "cancelado", "aguardando_pagamento", "sem_imagem"];
  const payments = ["", "gratis", "pago", "plano", "pendente", "devolvido", "nao_informado"];
  const status = clean(query.status), billing = clean(query.pagamento);
  if (!statuses.includes(status) || !payments.includes(billing)) throw new Error("Filtro inválido.");
  const page = Number(query.pagina || 1), limit = Number(query.limite || 25);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Página inválida.");
  return { from, to, start, end, status, billing, search: fold(query.busca), category: clean(query.produto, 80), page, limit };
}

function createAdminOrdersRouter({ auth, isAdmin, ordersDir, readCustomers, resolveOrderBase, productName, now = () => new Date() }) {
  const router = express.Router();
  const imageLocations = new Map();
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    next();
  }, auth, (req, res, next) => {
    const account = readCustomers()[req.user?.whatsapp];
    if (!isAdmin(req) || !account || account.ativo === false) return res.status(403).json({ ok: false, error: "Acesso exclusivo do administrador." });
    next();
  });

  router.get("/", async (req, res) => {
    let filter;
    try { filter = filters(req.query, now()); }
    catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
    try {
      const customers = readCustomers(), rows = [], categories = new Map();
      let unreadable = 0;
      const owners = await directories(ordersDir);
      await mapLimit(owners, 4, async owner => {
        const customerDir = path.join(ordersDir, owner.name);
        const firstMonth = [filter.from.slice(0, 7), new Date(filter.start).toISOString().slice(0, 7)].sort()[0];
        const lastMonth = [filter.to.slice(0, 7), new Date(filter.end - 1).toISOString().slice(0, 7)].sort().at(-1);
        const months = (await directories(customerDir)).filter(month => !/^\d{4}-\d{2}$/.test(month.name) || (month.name >= firstMonth && month.name <= lastMonth));
        for (const month of months) {
          const monthDir = path.join(customerDir, month.name);
          await mapLimit(await directories(monthDir), 4, async entry => {
            if (!validId(entry.name)) return;
            const base = path.join(monthDir, entry.name);
            let order;
            try { order = JSON.parse(await fs.readFile(path.join(base, "pedido.json"), "utf8")); if (!order || typeof order !== "object" || Array.isArray(order)) throw new Error(); }
            catch { unreadable++; return; }
            let time = Date.parse(order.criado_em || order.data_criacao || order.created_at || "");
            if (!Number.isFinite(time)) time = (await fs.stat(base)).mtimeMs;
            if (time < filter.start || time >= filter.end) return;
            const customer = customers[owner.name] || {};
            const identity = { id: clean(owner.name), nome_time: clean(customer.nome_time || order.nome_time || "Sem nome de time"), email: clean(customer.email), login: clean(customer.login || owner.name) };
            const category = clean(order.categoria || order.product_id, 80), product = clean(productName(category) || category || "Arte");
            categories.set(category, product);
            if (filter.category && category !== filter.category) return;
            if (filter.search && !fold([entry.name, identity.id, identity.nome_time, identity.email, identity.login, product].join(" ")).includes(filter.search)) return;
            let rawStatus = clean(order.status || "novo");
            try { rawStatus = clean(await fs.readFile(path.join(base, "status.txt"), "utf8")) || rawStatus; }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            const [imageReady, videoReady] = await Promise.all([exists(path.join(base, "resultado_final.png")), exists(path.join(base, "resultado_video.mp4"))]);
            const videoRequested = order.video_generation?.requested === true;
            const status = statusOf(rawStatus, imageReady, videoRequested, videoReady), billing = payment(order);
            if ((filter.status && filter.status !== status.tipo) || (filter.billing && filter.billing !== billing.tipo)) return;
            if (imageReady) {
              imageLocations.set(entry.name, base);
              if (imageLocations.size > 2000) imageLocations.delete(imageLocations.keys().next().value);
            }
            rows.push({ id: entry.name, criado_em: new Date(time).toISOString(), cliente: identity, categoria: category, produto: product,
              status: status.tipo, status_rotulo: status.rotulo, status_original: rawStatus, pagamento: billing,
              imagem_pronta: imageReady, video_pronto: videoReady, entrega: videoRequested ? "Imagem + vídeo" : "Imagem",
              imagem_url: imageReady ? "/admin/pedidos/" + encodeURIComponent(entry.name) + "/imagem" : null });
          });
        }
      });
      rows.sort((a, b) => b.criado_em.localeCompare(a.criado_em) || b.id.localeCompare(a.id));
      const summary = { pedidos: rows.length, clientes: new Set(rows.map(row => row.cliente.id)).size, gratis: 0, pagos: 0, planos: 0, pendentes: 0, erros: 0, prontos: 0 };
      for (const row of rows) {
        if (row.pagamento.tipo === "gratis") summary.gratis++;
        if (row.pagamento.tipo === "pago") summary.pagos++;
        if (row.pagamento.tipo === "plano") summary.planos++;
        if (row.pagamento.tipo === "pendente") summary.pendentes++;
        if (row.status === "erro") summary.erros++;
        if (row.status === "pronto") summary.prontos++;
      }
      const pages = Math.max(1, Math.ceil(rows.length / filter.limit)), page = Math.min(filter.page, pages);
      return res.json({ ok: true, atualizado_em: now().toISOString(), periodo: { desde: filter.from, ate: filter.to }, resumo: summary,
        produtos: [...categories].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
        pagina: page, paginas: pages, total: rows.length, limite: filter.limit, registros_ilegíveis: unreadable,
        pedidos: rows.slice((page - 1) * filter.limit, page * filter.limit) });
    } catch (error) {
      console.error("[admin_pedidos] Falha de leitura:", error.code || "unknown");
      return res.status(500).json({ ok: false, error: "Não foi possível consultar os pedidos. Tente novamente." });
    }
  });

  router.get("/:id/imagem", async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ ok: false, error: "Pedido inválido." });
    try {
      const base = imageLocations.get(req.params.id) || resolveOrderBase(req.params.id);
      if (!base) return res.status(404).json({ ok: false, error: "Imagem ainda não disponível." });
      const root = await fs.realpath(ordersDir), realBase = await fs.realpath(base);
      if (!realBase.startsWith(root + path.sep)) return res.sendStatus(404);
      const file = await fs.realpath(path.join(realBase, "resultado_final.png"));
      if (!file.startsWith(realBase + path.sep)) return res.sendStatus(404);
      if (req.query.mini === "1") {
        const data = await sharp(file).rotate().resize({ width: 240, height: 320, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        return res.type("jpeg").send(data);
      }
      return res.sendFile(file);
    } catch (error) {
      return res.status(error.code === "ENOENT" ? 404 : 500).json({ ok: false, error: "Não foi possível abrir a imagem." });
    }
  });
  return router;
}

module.exports = { createAdminOrdersRouter, payment, statusOf };
