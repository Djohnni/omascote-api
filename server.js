const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const archiver = require("archiver");
const crypto = require("crypto");
const productsRegistry = require("./src/products");
const orderStorage = require("./src/orders/order.storage");
const orderStatus = require("./src/orders/order.status");
const orderService = require("./src/orders/order.service");
const productAuditService = require("./src/orders/product-audit.service");
const billingService = require("./src/billing/billing.service");

const app = express();

// ===== CONFIG BÁSICA =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "TROQUE_ISSO_AGORA";

// ===== DATA STORAGE (RENDER DISK) =====
const isRender = process.env.RENDER || process.env.NODE_ENV === "production";

const DATA_DIR = isRender
  ? "/var/data"
  : path.join(__dirname, "dados");

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const BOT_ADMIN_WHATSAPP = process.env.BOT_ADMIN_WHATSAPP || "15991120599";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const MP_PROCESSADOS_FILE = path.join(DATA_DIR, "mp_processados.json");
const TEMPO_ESTIMADO_FILE = path.join(DATA_DIR, "tempo_estimado.json");
const ONLINE_FILE = path.join(DATA_DIR, "usuarios_online.json");
const SUPORTE_ABERTAS_FILE = path.join(DATA_DIR, "suporte_conversas_abertas.json");
const SUPORTE_FINALIZADAS_FILE = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
const PREVIEW_LIMITER_FILE = path.join(DATA_DIR, "preview_limiter.json");
const ANALYTICS_DIR = path.join(DATA_DIR, "analytics");
const PERFIS_DIR = path.join(DATA_DIR, "perfis");
const EVENTOS_CLIENTES_FILE = path.join(DATA_DIR, "eventos_clientes.json");
const CARTAS_APP_FILE = path.join(DATA_DIR, "cartas_app.json");
const CARTAS_APP_IMAGENS_DIR = path.join(DATA_DIR, "cartas_app_imagens");
const CUPONS_FILE = path.join(DATA_DIR, "cupons.json");
const CUPONS_LOCK = path.join(DATA_DIR, "cupons.lock");
const CUPONS_JOGADOR_ESCUDO_FILE = path.join(DATA_DIR, "cupons_jogador_escudo.json");
const CUPONS_JOGADOR_ESCUDO_LOCK = path.join(DATA_DIR, "cupons_jogador_escudo.lock");
const PRODUTO_AUDITORIA_FILE = path.join(DATA_DIR, "produto_auditoria.jsonl");
const PREVIEW_LIMITER_MAX = 3;
const PREVIEW_LIMITER_TTL_MS = 6 * 60 * 60 * 1000;

const CLIENTES_TESTE = [
  "Los Hermanos",
  "TESTE",
  "admin"
];

// CORS: permite seu site chamar a API
app.use(cors({
  origin: ["https://omascote.com.br", "https://www.omascote.com.br"],
  credentials: false
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// ===== GARANTE PASTAS =====
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(DATA_DIR);
ensureDir(PEDIDOS_DIR);
ensureDir(path.join(DATA_DIR, "tmp_uploads"));
ensureDir(ANALYTICS_DIR);
ensureDir(PERFIS_DIR);
ensureDir(CARTAS_APP_IMAGENS_DIR);

if (!fs.existsSync(CLIENTES_FILE)) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(MP_PROCESSADOS_FILE)) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(TEMPO_ESTIMADO_FILE)) {
  fs.writeFileSync(TEMPO_ESTIMADO_FILE, JSON.stringify({
    tempo_medio_segundos: 135,
    tempo_estimado_segundos: 135,
    pedidos_na_fila: 0,
    lotes: 1,
    max_processos: 5,
    atualizado_em: new Date().toISOString()
  }, null, 2), "utf8");
}

if (!fs.existsSync(ONLINE_FILE)) {
  fs.writeFileSync(ONLINE_FILE, JSON.stringify({}, null, 2), "utf8");
}

if (!fs.existsSync(SUPORTE_ABERTAS_FILE)) {
  fs.writeFileSync(SUPORTE_ABERTAS_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(SUPORTE_FINALIZADAS_FILE)) {
  fs.writeFileSync(SUPORTE_FINALIZADAS_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(EVENTOS_CLIENTES_FILE)) {
  fs.writeFileSync(EVENTOS_CLIENTES_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(PREVIEW_LIMITER_FILE)) {
  fs.writeFileSync(PREVIEW_LIMITER_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(CARTAS_APP_FILE)) {
  fs.writeFileSync(CARTAS_APP_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(CUPONS_FILE)) {
  fs.writeFileSync(CUPONS_FILE, JSON.stringify({
    voltou18: {
      codigo: "VOLTOU18",
      descricao: "Cupom de retorno 50%",
      ativo: true,
      tipo: "percentual",
      percentual: 50,
      valor: null,
      produtos: "todos",
      validade_inicio: null,
      validade_fim: null,
      limite_usos_total: null,
      usos_total: 0,
      limite_usos_por_cliente: null,
      usos_por_cliente: {},
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString()
    }
  }, null, 2), "utf8");
}

if (!fs.existsSync(CUPONS_JOGADOR_ESCUDO_FILE)) {
  fs.writeFileSync(CUPONS_JOGADOR_ESCUDO_FILE, JSON.stringify({}, null, 2), "utf8");
}

ensureCuponsIniciais();

// ===== HELPERS =====
function readClientes() {
  return JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8") || "{}");
}

function normalizarCupomCodigo(codigo) {
  return String(codigo || "").trim().toLowerCase();
}

function cupomCodigoPublico(codigo) {
  return String(codigo || "").trim().toUpperCase();
}

function novoCupomVoltou18() {
  const agora = new Date().toISOString();

  return {
    codigo: "VOLTOU18",
    descricao: "Cupom de retorno 50%",
    ativo: true,
    tipo: "percentual",
    percentual: 50,
    valor: null,
    produtos: "todos",
    validade_inicio: null,
    validade_fim: null,
    limite_usos_total: 100000,
    usos_total: 0,
    limite_usos_por_cliente: null,
    usos_por_cliente: {},
    criado_em: agora,
    atualizado_em: agora
  };
}

function readCupons() {
  try {
    const cupons = JSON.parse(fs.readFileSync(CUPONS_FILE, "utf8") || "{}");
    return cupons && typeof cupons === "object" && !Array.isArray(cupons) ? cupons : {};
  } catch {
    return {};
  }
}

function writeCupons(obj) {
  fs.writeFileSync(CUPONS_FILE, JSON.stringify(obj || {}, null, 2), "utf8");
}

function ensureCuponsIniciais() {
  const cupons = readCupons();
  let alterado = false;

  if (!cupons.voltou18) {
    cupons.voltou18 = novoCupomVoltou18();
    alterado = true;
  } else {
    const legadoVoltou18 = { ...cupons.voltou18 };
    if (!Number(legadoVoltou18.limite_usos_total || 0)) {
      legadoVoltou18.limite_usos_total = 100000;
    }
    const normalizado = normalizarCupomParaArmazenamento("voltou18", legadoVoltou18, { parcial: true, existente: legadoVoltou18 });
    cupons.voltou18 = {
      ...normalizado,
      codigo: normalizado.codigo || "VOLTOU18",
      descricao: normalizado.descricao || "Cupom de retorno 50%",
      ativo: normalizado.ativo !== false,
      tipo: normalizado.tipo || "percentual",
      percentual: Number(normalizado.percentual || 50),
      valor: normalizado.valor ?? null,
      produtos: normalizado.produtos || "todos"
    };
    if (!Number(cupons.voltou18.limite_usos_total || 0)) {
      cupons.voltou18.limite_usos_total = 100000;
    }
    alterado = true;
  }

  if (alterado) writeCupons(cupons);
}

function adquirirLockCupons() {
  try {
    if (fs.existsSync(CUPONS_LOCK)) {
      const stat = fs.statSync(CUPONS_LOCK);
      if (Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(CUPONS_LOCK);
    }

    const fd = fs.openSync(CUPONS_LOCK, "wx");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function liberarLockCupons() {
  try {
    if (fs.existsSync(CUPONS_LOCK)) fs.unlinkSync(CUPONS_LOCK);
  } catch {}
}

function normalizarListaProdutosCupom(produtos) {
  if (!produtos || produtos === "todos") return "todos";

  const lista = Array.isArray(produtos)
    ? produtos
    : String(produtos).split(",");

  const normalizada = [...new Set(lista.map(normalizarCupomCodigo).filter(Boolean))];
  return normalizada.length ? normalizada : "todos";
}

function normalizarDataCupom(value) {
  if (value === null || value === undefined || value === "") return null;
  const data = new Date(value);
  if (Number.isNaN(data.getTime())) return undefined;
  return data.toISOString();
}

function normalizarNumeroOpcional(value, { min = 0, integer = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return undefined;
  return integer ? Math.floor(n) : Number(n.toFixed(2));
}

function normalizarCupomParaArmazenamento(codigoParam, body = {}, { parcial = false, existente = null } = {}) {
  const agora = new Date().toISOString();
  const codigoNormalizado = normalizarCupomCodigo(body.codigo || codigoParam || existente?.codigo);

  if (!codigoNormalizado || codigoNormalizado.length < 3) {
    const err = new Error("Código de cupom inválido.");
    err.status = 400;
    throw err;
  }

  const base = parcial && existente ? { ...existente } : {};
  const cupom = {
    codigo: cupomCodigoPublico(body.codigo || base.codigo || codigoNormalizado),
    descricao: String(body.descricao ?? base.descricao ?? "").trim(),
    ativo: body.ativo === undefined ? (base.ativo !== false) : body.ativo !== false,
    tipo: String(body.tipo ?? base.tipo ?? "percentual").trim().toLowerCase(),
    percentual: base.percentual ?? null,
    valor: base.valor ?? null,
    produtos: body.produtos === undefined ? (base.produtos || "todos") : normalizarListaProdutosCupom(body.produtos),
    validade_inicio: base.validade_inicio ?? null,
    validade_fim: base.validade_fim ?? null,
    limite_usos_total: base.limite_usos_total ?? (parcial ? null : 1),
    usos_total: Number(base.usos_total || 0),
    limite_usos_por_cliente: base.limite_usos_por_cliente ?? null,
    usos_por_cliente: base.usos_por_cliente && typeof base.usos_por_cliente === "object" && !Array.isArray(base.usos_por_cliente)
      ? base.usos_por_cliente
      : {},
    criado_em: base.criado_em || agora,
    atualizado_em: agora
  };

  if (!["percentual", "valor"].includes(cupom.tipo)) {
    const err = new Error("Tipo de cupom inválido.");
    err.status = 400;
    throw err;
  }

  if (body.percentual !== undefined || !parcial || cupom.tipo === "percentual") {
    const percentual = normalizarNumeroOpcional(body.percentual ?? cupom.percentual, { min: 0 });
    if (percentual === undefined || cupom.tipo === "percentual" && (percentual <= 0 || percentual > 100)) {
      const err = new Error("Percentual de desconto inválido.");
      err.status = 400;
      throw err;
    }
    cupom.percentual = percentual;
  }

  if (body.valor !== undefined || !parcial || cupom.tipo === "valor") {
    const valor = normalizarNumeroOpcional(body.valor ?? cupom.valor, { min: 0 });
    if (valor === undefined || cupom.tipo === "valor" && valor <= 0) {
      const err = new Error("Valor fixo de desconto inválido.");
      err.status = 400;
      throw err;
    }
    cupom.valor = valor;
  }

  if (cupom.tipo === "percentual") cupom.valor = cupom.valor ?? null;
  if (cupom.tipo === "valor") cupom.percentual = cupom.percentual ?? null;

  if (body.validade_inicio !== undefined) {
    const data = normalizarDataCupom(body.validade_inicio);
    if (data === undefined) {
      const err = new Error("Validade inicial inválida.");
      err.status = 400;
      throw err;
    }
    cupom.validade_inicio = data;
  }

  if (body.validade_fim !== undefined) {
    const data = normalizarDataCupom(body.validade_fim);
    if (data === undefined) {
      const err = new Error("Validade final inválida.");
      err.status = 400;
      throw err;
    }
    cupom.validade_fim = data;
  }

  if (cupom.validade_inicio && cupom.validade_fim && new Date(cupom.validade_inicio).getTime() > new Date(cupom.validade_fim).getTime()) {
    const err = new Error("Validade inicial não pode ser maior que a validade final.");
    err.status = 400;
    throw err;
  }

  if (body.limite_usos_total !== undefined) {
    const limite = normalizarNumeroOpcional(body.limite_usos_total, { min: 1, integer: true });
    if (limite === undefined || limite === null) {
      const err = new Error("Limite total de usos inválido.");
      err.status = 400;
      throw err;
    }
    cupom.limite_usos_total = limite;
  }

  if (!parcial && !Number(cupom.limite_usos_total || 0)) {
    cupom.limite_usos_total = 1;
  }

  if (body.limite_usos_por_cliente !== undefined) {
    const limite = normalizarNumeroOpcional(body.limite_usos_por_cliente, { min: 1, integer: true });
    if (limite === undefined) {
      const err = new Error("Limite de usos por cliente inválido.");
      err.status = 400;
      throw err;
    }
    cupom.limite_usos_por_cliente = limite;
  }

  if (body.usos_total !== undefined) {
    const usos = normalizarNumeroOpcional(body.usos_total, { min: 0, integer: true });
    if (usos === undefined) {
      const err = new Error("Total de usos inválido.");
      err.status = 400;
      throw err;
    }
    cupom.usos_total = usos;
  }

  if (body.usos_por_cliente !== undefined) {
    if (!body.usos_por_cliente || typeof body.usos_por_cliente !== "object" || Array.isArray(body.usos_por_cliente)) {
      const err = new Error("Usos por cliente inválido.");
      err.status = 400;
      throw err;
    }
    cupom.usos_por_cliente = Object.fromEntries(
      Object.entries(body.usos_por_cliente)
        .map(([cliente, total]) => [normalizarCupomCodigo(cliente), Math.max(0, Math.floor(Number(total || 0)))])
        .filter(([cliente]) => cliente)
    );
  }

  return cupom;
}

function gerarCodigoCupomAutomatico(prefixo = "PROMO") {
  const safePrefix = String(prefixo || "PROMO").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16) || "PROMO";
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";

  for (let i = 0; i < 5; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return `${safePrefix}-${suffix}`;
}

function readCuponsJogadorEscudo() {
  try {
    return JSON.parse(fs.readFileSync(CUPONS_JOGADOR_ESCUDO_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeCuponsJogadorEscudo(obj) {
  fs.writeFileSync(CUPONS_JOGADOR_ESCUDO_FILE, JSON.stringify(obj || {}, null, 2), "utf8");
}

function adquirirLockCupomJogadorEscudo() {
  try {
    if (fs.existsSync(CUPONS_JOGADOR_ESCUDO_LOCK)) {
      const stat = fs.statSync(CUPONS_JOGADOR_ESCUDO_LOCK);
      if (Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(CUPONS_JOGADOR_ESCUDO_LOCK);
    }

    const fd = fs.openSync(CUPONS_JOGADOR_ESCUDO_LOCK, "wx");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function liberarLockCupomJogadorEscudo() {
  try {
    if (fs.existsSync(CUPONS_JOGADOR_ESCUDO_LOCK)) fs.unlinkSync(CUPONS_JOGADOR_ESCUDO_LOCK);
  } catch {}
}

function writeClientes(obj) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function readMpProcessados() {
  return JSON.parse(fs.readFileSync(MP_PROCESSADOS_FILE, "utf8") || "{}");
}

function writeMpProcessados(obj) {
  fs.writeFileSync(MP_PROCESSADOS_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function readPreviewLimiter() {
  try {
    const data = JSON.parse(fs.readFileSync(PREVIEW_LIMITER_FILE, "utf8") || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writePreviewLimiter(lista) {
  fs.writeFileSync(PREVIEW_LIMITER_FILE, JSON.stringify(lista || [], null, 2), "utf8");
}

function readTempoEstimado() {
  try {
    return JSON.parse(fs.readFileSync(TEMPO_ESTIMADO_FILE, "utf8") || "{}");
  } catch {
    return {
      tempo_medio_segundos: 135,
      tempo_estimado_segundos: 135,
      pedidos_na_fila: 0,
      lotes: 1,
      max_processos: 5,
      atualizado_em: new Date().toISOString()
    };
  }
}

function writeTempoEstimado(obj) {
  fs.writeFileSync(TEMPO_ESTIMADO_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function getCustoPedido(categoria, cliente) {
  const registryPrice = productsRegistry.getProductPrice(categoria, cliente);
  if (registryPrice !== null) return registryPrice;

  if (categoria === "resultado") return 8.00;
  if (categoria === "escalacao") return 8.00;
  if (categoria === "contratacao") return 7.00;
  if (categoria === "proximo_jogo") return 7.00;
  if (categoria === "patrocinador") return 8.00;
  if (categoria === "escudo3d") return 4.00;

  if (categoria === "proximo_jogo_jogador") return 7.00;
  if (categoria === "resultado_jogo_jogador") return 8.00;
  if (categoria === "jogador_escudo") return 6.00;
  if (categoria === "mascote_uniforme") {
    return 18.00;
  }

  return 0;
}

const CREDITOS_SALDO_PERMITIDOS = new Set([800, 1800, 2800, 4800]);

function normalizarValorFinanceiro(valor) {
  const numero = Number(valor || 0);
  return Number.isFinite(numero) ? Number(numero.toFixed(2)) : 0;
}

function valorFinanceiroEmCentavos(valor) {
  return Math.round(normalizarValorFinanceiro(valor) * 100);
}

function validarCreditoSaldoMercadoPago(valor) {
  const credito = normalizarValorFinanceiro(valor);
  const creditoCentavos = valorFinanceiroEmCentavos(credito);

  return {
    ok: CREDITOS_SALDO_PERMITIDOS.has(creditoCentavos),
    credito,
    acimaDoLimite: credito > 60
  };
}

function calcularBonusPrimeiraCompraSeguro(pedido, pagamento) {
  const valorInformado = normalizarValorFinanceiro(
    pedido?.valor_pendente ||
    pedido?.valor_final ||
    pagamento?.metadata?.valor_pendente ||
    0
  );

  const categoria = pedido?.categoria || pedido?.product_id || "";
  const valorProduto = normalizarValorFinanceiro(getCustoPedido(categoria, null));
  const limites = [
    normalizarValorFinanceiro(pedido?.valor_pendente),
    normalizarValorFinanceiro(pedido?.valor_final),
    normalizarValorFinanceiro(pedido?.valor_original),
    valorProduto
  ].filter(valor => valor > 0 && valor <= 60);

  const limitePedido = limites.length ? Math.min(...limites) : 18;
  return normalizarValorFinanceiro(Math.min(valorInformado, limitePedido, 18));
}

function produtoAceitaCupom(cupom, categoria) {
  const produtos = cupom?.produtos;

  if (!produtos || produtos === "todos") return true;
  if (Array.isArray(produtos)) return produtos.map(String).map(normalizarCupomCodigo).includes(normalizarCupomCodigo(categoria));

  return normalizarCupomCodigo(produtos) === normalizarCupomCodigo(categoria);
}

function cupomEstaDentroDaValidade(cupom, agora = new Date()) {
  const time = agora.getTime();
  const inicio = cupom?.validade_inicio ? new Date(cupom.validade_inicio).getTime() : null;
  const fim = cupom?.validade_fim ? new Date(cupom.validade_fim).getTime() : null;

  if (inicio && time < inicio) return false;
  if (fim && time > fim) return false;

  return true;
}

function cupomTemUsoDisponivel(cupom, whatsapp) {
  const limiteTotal = Number(cupom?.limite_usos_total || 0);
  const usosTotal = Number(cupom?.usos_total || 0);

  if (limiteTotal > 0 && usosTotal >= limiteTotal) return false;

  const limiteCliente = Number(cupom?.limite_usos_por_cliente || 0);
  if (limiteCliente > 0) {
    const chaveCliente = normalizarCupomCodigo(whatsapp);
    const usosCliente = Number(cupom?.usos_por_cliente?.[chaveCliente] || 0);
    if (usosCliente >= limiteCliente) return false;
  }

  return true;
}

function calcularDescontoCupom(cupom, valorOriginal) {
  const original = Number(valorOriginal || 0);

  if (!cupom || original <= 0) return 0;

  if (cupom.tipo === "percentual") {
    const percentual = Math.max(0, Math.min(100, Number(cupom.percentual || 0)));
    return Number((original * percentual / 100).toFixed(2));
  }

  if (cupom.tipo === "valor") {
    return Number(Math.min(original, Math.max(0, Number(cupom.valor || 0))).toFixed(2));
  }

  return 0;
}

function validarCupomPedido({ codigo, categoria, valorOriginal, whatsapp }) {
  const cupomCodigo = normalizarCupomCodigo(codigo);

  if (!cupomCodigo) {
    return {
      ok: true,
      cupomAplicado: false,
      valorOriginal: Number(Number(valorOriginal || 0).toFixed(2)),
      desconto: 0,
      valorFinal: Number(Number(valorOriginal || 0).toFixed(2))
    };
  }

  const original = Number(Number(valorOriginal || 0).toFixed(2));

  if (original <= 0) {
    return { ok: false, status: 400, error: "Cupom válido apenas para produtos pagos." };
  }

  const cupons = readCupons();
  const cupom = cupons[cupomCodigo];

  if (!cupom) {
    return { ok: false, status: 400, error: "Cupom não encontrado." };
  }

  if (cupom.ativo === false) {
    return { ok: false, status: 400, error: "Cupom inativo." };
  }

  if (!cupomEstaDentroDaValidade(cupom)) {
    return { ok: false, status: 400, error: "Cupom fora da validade." };
  }

  if (!cupomTemUsoDisponivel(cupom, whatsapp)) {
    return { ok: false, status: 400, error: "Cupom sem usos disponiveis." };
  }

  if (!produtoAceitaCupom(cupom, categoria)) {
    return { ok: false, status: 400, error: "Cupom não é válido para este produto." };
  }

  const desconto = calcularDescontoCupom(cupom, original);

  if (desconto <= 0) {
    return { ok: false, status: 400, error: "Cupom sem desconto disponível." };
  }

  const valorFinal = Number(Math.max(0, original - desconto).toFixed(2));

  return {
    ok: true,
    cupomAplicado: true,
    cupomCodigo,
    cupom,
    valorOriginal: original,
    desconto,
    valorFinal,
    resumo: {
      codigo: String(cupom.codigo || cupomCodigo).toUpperCase(),
      tipo: cupom.tipo || "percentual",
      percentual: cupom.tipo === "percentual" ? Number(cupom.percentual || 0) : undefined,
      valor: cupom.tipo === "valor" ? Number(cupom.valor || 0) : undefined,
      valor_original: original,
      desconto,
      valor_final: valorFinal
    }
  };
}

function aplicarResumoCupomNoPedido(pedido, resultadoCupom) {
  if (!resultadoCupom?.cupomAplicado) return;

  pedido.cupom_aplicado = true;
  pedido.cupom_codigo = resultadoCupom.resumo.codigo;
  pedido.cupom_codigo_normalizado = resultadoCupom.cupomCodigo;
  pedido.cupom_tipo = resultadoCupom.resumo.tipo;
  pedido.cupom_percentual = resultadoCupom.resumo.percentual;
  pedido.cupom_valor = resultadoCupom.resumo.valor;
  pedido.cupom_uso_registrado = pedido.cupom_uso_registrado === true;
  pedido.valor_original = resultadoCupom.valorOriginal;
  pedido.valor_desconto = resultadoCupom.desconto;
  pedido.valor_final = resultadoCupom.valorFinal;
  pedido.desconto_info = {
    cupom_codigo: resultadoCupom.resumo.codigo,
    cupom_codigo_normalizado: resultadoCupom.cupomCodigo,
    tipo: resultadoCupom.resumo.tipo,
    percentual: resultadoCupom.resumo.percentual,
    valor: resultadoCupom.resumo.valor,
    valor_original: resultadoCupom.valorOriginal,
    desconto: resultadoCupom.desconto,
    valor_final: resultadoCupom.valorFinal
  };
}

function registrarUsoCupomPedido(pedido, whatsapp) {
  if (!pedido?.cupom_aplicado || pedido.cupom_uso_registrado === true) return { ok: true, skipped: true };

  const codigo = normalizarCupomCodigo(pedido.cupom_codigo_normalizado || pedido.cupom_codigo || pedido.desconto_info?.cupom_codigo);
  if (!codigo) return { ok: true, skipped: true };

  let lockAtivo = false;

  try {
    lockAtivo = adquirirLockCupons();

    if (!lockAtivo) {
      return { ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." };
    }

    const cupons = readCupons();
    const cupom = cupons[codigo];

    if (!cupom) {
      return { ok: true, skipped: true };
    }

    const chaveCliente = normalizarCupomCodigo(whatsapp);
    cupom.usos_total = Number(cupom.usos_total || 0) + 1;
    cupom.usos_por_cliente = cupom.usos_por_cliente && typeof cupom.usos_por_cliente === "object" && !Array.isArray(cupom.usos_por_cliente)
      ? cupom.usos_por_cliente
      : {};

    if (chaveCliente) {
      cupom.usos_por_cliente[chaveCliente] = Number(cupom.usos_por_cliente[chaveCliente] || 0) + 1;
    }

    cupom.atualizado_em = new Date().toISOString();
    if (Number(cupom.limite_usos_total || 0) > 0 && Number(cupom.usos_total || 0) >= Number(cupom.limite_usos_total || 0)) {
      cupom.ativo = false;
    }
    cupons[codigo] = cupom;
    writeCupons(cupons);

    pedido.cupom_uso_registrado = true;
    pedido.cupom_uso_registrado_em = new Date().toISOString();

    return { ok: true };
  } finally {
    if (lockAtivo) liberarLockCupons();
  }
}

function clienteElegivelBrindeEscudo3dApp(req, cliente, whatsapp, categoria) {
  if (categoria !== "escudo3d") return false;
  if (!cliente || cliente.brinde_escudo3d_app_usado === true) return false;

  const origemAcesso = String(req.body?.origem_acesso || "").toLowerCase();
  const displayMode = String(req.body?.display_mode || "").toLowerCase();
  const estaNoApp = origemAcesso === "pwa" || displayMode === "standalone";
  if (!estaNoApp) return false;

  if (Number(cliente.usados_no_ciclo || 0) > 0) return false;
  if (Number(cliente.saldo_mensal || 0) + Number(cliente.saldo_extra || 0) > 0) return false;
  if (cliente.brinde_mascote_ja_liberado === true) return false;
  if (listPedidoBasesByWhatsapp(whatsapp).length > 0) return false;

  return true;
}

function nomeCategoriaPedido(categoria) {
  const registryName = productsRegistry.getProductName(categoria);
  if (registryName) return registryName;

  const nomes = {
    resultado: "Resultado do jogo",
    escalacao: "Escalação",
    contratacao: "Contratação",
    proximo_jogo: "Próximo jogo",
    patrocinador: "Patrocinador / Apoio",
    escudo3d: "Escudo 3D",
    proximo_jogo_jogador: "Próximo jogo jogador",
    resultado_jogo_jogador: "Resultado jogador",
    jogador_escudo: "Jogador + escudo",
    mascote_uniforme: "Mascote + uniforme"
  };

  return nomes[categoria] || categoria || "";
}

function normalizarLoginId(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "");
}

function gerarSenhaAutomatica() {
  return "ia4" + Math.random().toString(36).slice(2, 8);
}

function criarLoginAutomaticoUnico(base, clientes) {
  let loginBase = normalizarLoginId(base);

  if (!loginBase || loginBase.length < 3) {
    loginBase = "jogador";
  }

  let login = "auto_" + loginBase + "_" + Date.now();

  while (clientes[login]) {
    login = "auto_" + loginBase + "_" + Date.now() + "_" + Math.floor(Math.random() * 999);
  }

  return login;
}

function nowYYYYMM() {
  return orderStorage.nowYYYYMM();
}

function newPedidoId() {
  return orderStorage.newPedidoId();
}

function getPedidoBase(whatsapp, pedidoId) {
  return orderStorage.getPedidoBase(PEDIDOS_DIR, whatsapp, pedidoId);
}

function safeReadJson(filePath) {
  return orderStorage.safeReadJson(filePath);
}

function isBotAdmin(req) {
  return req.user && req.user.whatsapp === BOT_ADMIN_WHATSAPP;
}

function getPedidoBaseGlobal(pedidoId) {
  return orderStorage.getPedidoBaseGlobal(PEDIDOS_DIR, pedidoId);
}

function listPedidoBasesByWhatsapp(whatsapp) {
  return orderStorage.listPedidoBasesByWhatsapp(PEDIDOS_DIR, whatsapp);
}

function removeOldPedidos(whatsapp, maxKeep = 15) {
  return orderStorage.removeOldPedidos(PEDIDOS_DIR, whatsapp, maxKeep);
}

function getPreviewLimiterIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "";
}

function getPreviewLimiterIdentifiers(req, cliente, whatsapp) {
  const clienteId = cliente?.cliente_id || cliente?.id || "";
  const deviceId = cliente?.device_id || req.body?.device_id || req.headers["x-device-id"] || req.headers["x-session-id"] || "";
  const ip = getPreviewLimiterIp(req);
  const identifiers = [];

  if (clienteId) identifiers.push(`cliente:${clienteId}`);
  if (whatsapp) identifiers.push(`whatsapp:${whatsapp}`);
  if (deviceId) identifiers.push(`device:${deviceId}`);
  if (!identifiers.length) identifiers.push(`ip:${ip || "desconhecido"}`);

  return identifiers;
}

function isPedidoSemPagamentoConfirmado(pedido) {
  if (!pedido) return false;
  if (pedido.pagamento_pendente === true) return true;

  return (
    Number(pedido.valor_pendente || 0) > 0 &&
    pedido.pagamento_pendente !== false &&
    !pedido.pagamento_confirmado_em
  );
}

function previewLimiterEntryStillCounts(entry) {
  if (!entry?.whatsapp || !entry?.pedido_id) return true;

  const base = getPedidoBase(entry.whatsapp, entry.pedido_id);
  if (!base) return false;

  try {
    const pedido = readPedido(base);
    return isPedidoSemPagamentoConfirmado(pedido);
  } catch {
    return false;
  }
}

function getPreviewLimiterState(identifiers) {
  const agora = Date.now();
  const lista = readPreviewLimiter();
  const ativos = [];
  const wanted = new Set(Array.isArray(identifiers) ? identifiers : [identifiers].filter(Boolean));
  const totals = {};

  for (const entry of lista) {
    const criadoEm = Number(entry.criado_em || 0);
    if (!criadoEm || (agora - criadoEm) > PREVIEW_LIMITER_TTL_MS) continue;
    if (!previewLimiterEntryStillCounts(entry)) continue;

    ativos.push(entry);

    const entryIdentifiers = Array.isArray(entry.identificadores)
      ? entry.identificadores
      : [entry.identificador].filter(Boolean);

    entryIdentifiers.forEach(identifier => {
      if (!wanted.has(identifier)) return;
      totals[identifier] = (totals[identifier] || 0) + 1;
    });
  }

  if (ativos.length !== lista.length) {
    writePreviewLimiter(ativos);
  }

  let total = 0;
  let identificador = Array.from(wanted)[0] || "desconhecido";

  Object.entries(totals).forEach(([key, value]) => {
    if (value > total) {
      total = value;
      identificador = key;
    }
  });

  return { total, identificador };
}

function registrarPreviewPendente({ identifiers, whatsapp, pedidoId }) {
  if (!pedidoId) return;

  const listaIdentificadores = Array.isArray(identifiers)
    ? identifiers.filter(Boolean)
    : [identifiers].filter(Boolean);

  if (!listaIdentificadores.length) return;

  const agora = Date.now();
  const lista = readPreviewLimiter().filter(entry => {
    const criadoEm = Number(entry.criado_em || 0);
    return criadoEm && (agora - criadoEm) <= PREVIEW_LIMITER_TTL_MS;
  });

  lista.push({
    identificador: listaIdentificadores[0],
    identificadores: listaIdentificadores,
    whatsapp,
    pedido_id: pedidoId,
    criado_em: agora
  });

  writePreviewLimiter(lista);
}

function readPedido(base) {
  return orderStorage.readOrder(base);
}

function writePedido(base, pedido) {
  return orderStorage.writeOrder(base, pedido);
}

function readOrderStatus(base, fallback = "") {
  return orderStorage.readStatus(base, fallback);
}

function writeOrderStatus(base, status) {
  return orderStorage.writeStatus(base, status);
}

function readJsonArraySafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizarPerfilId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "");
}

function gerarPerfilIdCliente(clienteId) {
  const hash = crypto
    .createHash("sha256")
    .update(`${JWT_SECRET}|perfil|${String(clienteId || "")}`)
    .digest("hex")
    .slice(0, 20);

  return `pf_${hash}`;
}

function getPerfilDir(perfilId) {
  return path.join(PERFIS_DIR, normalizarPerfilId(perfilId));
}

function getPerfilFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "perfil.json");
}

function getPerfilJogadoresFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "jogadores.json");
}

function getPerfilJogosFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "jogos.json");
}

function textoPerfil(value, max = 80) {
  return String(value || "").trim().slice(0, max);
}

function assetPerfil(value) {
  return textoPerfil(value, 260)
    .replace(/[<>"']/g, "")
    .trim();
}

function normalizarInstagramPerfil(value) {
  return textoPerfil(value, 80)
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/^@+/, "")
    .replace(/\/+$/g, "")
    .trim();
}

function perfilDefault(cliente, perfilId) {
  const agora = new Date().toISOString();

  return {
    perfil_id: perfilId,
    nome_time: textoPerfil(cliente?.nome_time || "Meu time"),
    cidade: "",
    estado: "",
    instagram: "",
    escudo_url: "",
    escudo_path: "",
    mascote_url: "",
    mascote_path: "",
    descricao_curta: "",
    publico: false,
    criado_em: agora,
    atualizado_em: agora
  };
}

function normalizarPerfilPrivado(perfil, cliente, perfilId) {
  const base = perfil && typeof perfil === "object" && !Array.isArray(perfil)
    ? perfil
    : {};
  const agora = new Date().toISOString();

  return {
    perfil_id: perfilId,
    nome_time: textoPerfil(base.nome_time || cliente?.nome_time || "Meu time"),
    cidade: textoPerfil(base.cidade || ""),
    estado: textoPerfil(base.estado || "", 40),
    instagram: normalizarInstagramPerfil(base.instagram || ""),
    escudo_url: assetPerfil(base.escudo_url || ""),
    escudo_path: assetPerfil(base.escudo_path || ""),
    mascote_url: assetPerfil(base.mascote_url || ""),
    mascote_path: assetPerfil(base.mascote_path || ""),
    descricao_curta: textoPerfil(base.descricao_curta || "", 240),
    publico: false,
    criado_em: base.criado_em || agora,
    atualizado_em: base.atualizado_em || agora
  };
}

function ensurePerfilCliente(clientes, clienteId) {
  const cliente = clientes[clienteId];

  if (!cliente) {
    const err = new Error("Cliente nao encontrado");
    err.status = 404;
    throw err;
  }

  let perfilId = normalizarPerfilId(cliente.perfil_id);
  let clienteAlterado = false;

  if (!perfilId) {
    perfilId = gerarPerfilIdCliente(clienteId);
    cliente.perfil_id = perfilId;
    clienteAlterado = true;
  }

  const perfilDir = getPerfilDir(perfilId);
  const perfilFile = getPerfilFile(perfilId);
  ensureDir(perfilDir);

  const perfilAtual = safeReadJson(perfilFile);
  const perfil = perfilAtual
    ? normalizarPerfilPrivado(perfilAtual, cliente, perfilId)
    : perfilDefault(cliente, perfilId);

  if (!perfilAtual) {
    writeJsonSafe(perfilFile, perfil);
  }

  if (clienteAlterado) {
    clientes[clienteId] = cliente;
    writeClientes(clientes);
  }

  return {
    cliente,
    perfil,
    perfil_id: perfilId,
    perfil_file: perfilFile
  };
}

function perfilResponse(perfil) {
  return {
    perfil_id: perfil.perfil_id,
    nome_time: perfil.nome_time,
    cidade: perfil.cidade,
    estado: perfil.estado,
    instagram: perfil.instagram,
    escudo_url: perfil.escudo_url || "",
    escudo_path: perfil.escudo_path || "",
    mascote_url: perfil.mascote_url || "",
    mascote_path: perfil.mascote_path || "",
    descricao_curta: perfil.descricao_curta || "",
    publico: false,
    criado_em: perfil.criado_em,
    atualizado_em: perfil.atualizado_em
  };
}

function gerarJogadorId() {
  return `jog_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizarJogadorId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "").slice(0, 80);
}

function jogadorResponse(jogador) {
  return {
    id: jogador.id,
    nome: jogador.nome,
    apelido: jogador.apelido || "",
    numero: jogador.numero || "",
    posicao: jogador.posicao || "",
    foto_url: jogador.foto_url || "",
    ativo: jogador.ativo !== false,
    criado_em: jogador.criado_em,
    atualizado_em: jogador.atualizado_em
  };
}

function normalizarJogador(jogador) {
  const base = jogador && typeof jogador === "object" && !Array.isArray(jogador)
    ? jogador
    : {};
  const agora = new Date().toISOString();

  return {
    id: normalizarJogadorId(base.id) || gerarJogadorId(),
    nome: textoPerfil(base.nome || "", 80),
    apelido: textoPerfil(base.apelido || "", 60),
    numero: textoPerfil(base.numero || "", 12),
    posicao: textoPerfil(base.posicao || "", 40),
    foto_url: assetPerfil(base.foto_url || ""),
    ativo: base.ativo !== false,
    criado_em: base.criado_em || agora,
    atualizado_em: base.atualizado_em || agora
  };
}

function readPerfilJogadores(perfilId) {
  return readJsonArraySafe(getPerfilJogadoresFile(perfilId))
    .map(normalizarJogador)
    .filter(jogador => jogador.id);
}

function writePerfilJogadores(perfilId, jogadores) {
  ensureDir(getPerfilDir(perfilId));
  writeJsonSafe(getPerfilJogadoresFile(perfilId), jogadores.map(jogadorResponse));
}

function payloadJogador(body, jogadorAtual = {}) {
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const agora = new Date().toISOString();

  return normalizarJogador({
    ...jogadorAtual,
    nome: payload.nome ?? jogadorAtual.nome,
    apelido: payload.apelido ?? jogadorAtual.apelido,
    numero: payload.numero ?? jogadorAtual.numero,
    posicao: payload.posicao ?? jogadorAtual.posicao,
    foto_url: payload.foto_url ?? jogadorAtual.foto_url,
    ativo: typeof payload.ativo === "boolean" ? payload.ativo : jogadorAtual.ativo,
    atualizado_em: agora
  });
}

function gerarJogoId() {
  return `jogo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizarJogoId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "").slice(0, 80);
}

function normalizarTipoJogo(value) {
  const tipo = String(value || "").trim().toLowerCase();
  return ["resultado", "proximo_jogo"].includes(tipo) ? tipo : "";
}

function jogoResponse(jogo) {
  return {
    id: jogo.id,
    tipo: jogo.tipo,
    adversario: jogo.adversario,
    meu_time_gols: jogo.meu_time_gols || "",
    adversario_gols: jogo.adversario_gols || "",
    data: jogo.data || "",
    horario: jogo.horario || "",
    local: jogo.local || "",
    campeonato: jogo.campeonato || "",
    status: jogo.status || "",
    ativo: jogo.ativo !== false,
    criado_em: jogo.criado_em,
    atualizado_em: jogo.atualizado_em
  };
}

function normalizarJogo(jogo) {
  const base = jogo && typeof jogo === "object" && !Array.isArray(jogo)
    ? jogo
    : {};
  const agora = new Date().toISOString();

  return {
    id: normalizarJogoId(base.id) || gerarJogoId(),
    tipo: normalizarTipoJogo(base.tipo) || "proximo_jogo",
    adversario: textoPerfil(base.adversario || "", 80),
    meu_time_gols: textoPerfil(base.meu_time_gols || "", 8),
    adversario_gols: textoPerfil(base.adversario_gols || "", 8),
    data: textoPerfil(base.data || "", 20),
    horario: textoPerfil(base.horario || "", 20),
    local: textoPerfil(base.local || "", 80),
    campeonato: textoPerfil(base.campeonato || "", 80),
    status: textoPerfil(base.status || "", 40),
    ativo: base.ativo !== false,
    criado_em: base.criado_em || agora,
    atualizado_em: base.atualizado_em || agora
  };
}

function readPerfilJogos(perfilId) {
  return readJsonArraySafe(getPerfilJogosFile(perfilId))
    .map(normalizarJogo)
    .filter(jogo => jogo.id);
}

function writePerfilJogos(perfilId, jogos) {
  ensureDir(getPerfilDir(perfilId));
  writeJsonSafe(getPerfilJogosFile(perfilId), jogos.map(jogoResponse));
}

function payloadJogo(body, jogoAtual = {}) {
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const agora = new Date().toISOString();

  return normalizarJogo({
    ...jogoAtual,
    tipo: payload.tipo ?? jogoAtual.tipo,
    adversario: payload.adversario ?? jogoAtual.adversario,
    meu_time_gols: payload.meu_time_gols ?? jogoAtual.meu_time_gols,
    adversario_gols: payload.adversario_gols ?? jogoAtual.adversario_gols,
    data: payload.data ?? jogoAtual.data,
    horario: payload.horario ?? jogoAtual.horario,
    local: payload.local ?? jogoAtual.local,
    campeonato: payload.campeonato ?? jogoAtual.campeonato,
    status: payload.status ?? jogoAtual.status,
    ativo: typeof payload.ativo === "boolean" ? payload.ativo : jogoAtual.ativo,
    atualizado_em: agora
  });
}

function readCartasApp() {
  try {
    const cartas = safeReadJson(CARTAS_APP_FILE) || [];
    return Array.isArray(cartas) ? cartas : [];
  } catch {
    return [];
  }
}

function writeCartasApp(cartas) {
  writeJsonSafe(CARTAS_APP_FILE, Array.isArray(cartas) ? cartas : []);
}

function gerarCartaAppId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const data = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hora = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const sufixo = Math.random().toString(36).slice(2, 6);
  return `${data}_${hora}_${sufixo}`;
}

function normalizarPublicoCartaApp(publico) {
  if (!publico || typeof publico !== "object") {
    return {
      todos: true,
      clientes_ids: []
    };
  }

  return {
    todos: publico.todos === true,
    clientes_ids: Array.isArray(publico.clientes_ids)
      ? publico.clientes_ids.map(id => String(id || "").trim()).filter(Boolean)
      : []
  };
}

function normalizarCartaAppPayload(body = {}) {
  return {
    id: gerarCartaAppId(),
    titulo: String(body.titulo || "Mensagem da IA4Tube").trim() || "Mensagem da IA4Tube",
    texto_curto: String(body.texto_curto || "").trim(),
    texto: String(body.texto || "").trim(),
    imagem_url: String(body.imagem_url || "").trim(),
    imagem_path: "",
    somente_app: body.somente_app !== false,
    ativo: body.ativo !== false,
    publico: normalizarPublicoCartaApp(body.publico),
    criado_em: new Date().toISOString()
  };
}

function getExtensaoImagemCarta(mimetype) {
  const mime = String(mimetype || "").toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  return "";
}

function sanitizeCartaApp(carta, cartasLidas = []) {
  const id = String(carta?.id || "").trim();
  if (!id) return null;

  return {
    id,
    titulo: String(carta?.titulo || "Mensagem da IA4Tube"),
    texto_curto: String(carta?.texto_curto || ""),
    texto: String(carta?.texto || ""),
    imagem_url: String(carta?.imagem_url || ""),
    tem_imagem: Boolean(carta?.imagem_url || carta?.imagem_path),
    criado_em: String(carta?.criado_em || ""),
    lida: cartasLidas.includes(id)
  };
}

function cartaAppPermitidaParaCliente(carta, clienteId) {
  const publico = carta?.publico;
  if (!publico) return true;
  if (publico.todos === true) return true;

  if (publico.todos === false) {
    const idAtual = String(clienteId || "").trim();
    const clientesIds = Array.isArray(publico.clientes_ids)
      ? publico.clientes_ids.map(id => String(id || "").trim()).filter(Boolean)
      : [];

    return Boolean(idAtual) && clientesIds.includes(idAtual);
  }

  return true;
}

function getCartaAppAtivaById(id) {
  const cartaId = String(id || "").trim();
  if (!cartaId) return null;

  return readCartasApp().find(carta =>
    String(carta?.id || "") === cartaId &&
    carta?.ativo === true
  ) || null;
}

function pedidoBaseTimestamp(item) {
  const pedido = item?.pedido || {};
  return new Date(pedido.criado_em || pedido.data_criacao || pedido.created_at || 0).getTime() || 0;
}

function getPedidoIdFromBase(base) {
  return path.basename(String(base || ""));
}

function nomeCategoriaResumo(categoria) {
  const nomes = {
    resultado: "Resultado",
    escalacao: "Escalação",
    contratacao: "Contratação",
    proximo_jogo: "Próximo jogo",
    patrocinador: "Patrocinador",
    escudo3d: "Escudo 3D",
    proximo_jogo_jogador: "Próximo jogo jogador",
    resultado_jogo_jogador: "Resultado jogador",
    jogador_escudo: "Jogador + escudo",
    mascote_uniforme: "Mascote"
  };

  return nomes[categoria] || categoria || "Sem categoria";
}

function encontrarEscudoPrincipalCliente(whatsapp) {
  const pedidos = listPedidoBasesByWhatsapp(whatsapp)
    .slice()
    .sort((a, b) => pedidoBaseTimestamp(b) - pedidoBaseTimestamp(a))
    .slice(0, 15);

  for (const item of pedidos) {
    const base = item?.base;
    if (!base) continue;

    for (const arquivo of ["escudo1.png", "escudo2.png"]) {
      const arquivoPath = path.join(base, arquivo);

      if (fs.existsSync(arquivoPath)) {
        return {
          encontrado: true,
          pedido_id: item?.pedido?.id || getPedidoIdFromBase(base),
          arquivo,
          path: arquivoPath,
          caminho_relativo: path.relative(DATA_DIR, arquivoPath).replace(/\\/g, "/")
        };
      }
    }
  }

  return {
    encontrado: false,
    pedido_id: "",
    arquivo: "",
    path: "",
    caminho_relativo: ""
  };
}

function getUltimoPedidoCliente(whatsapp) {
  const pedidos = listPedidoBasesByWhatsapp(whatsapp)
    .slice()
    .sort((a, b) => pedidoBaseTimestamp(b) - pedidoBaseTimestamp(a));

  const pedidosResumo = pedidos.slice(0, 10).map(item => {
    const pedido = item.pedido || {};
    const id = pedido.id || getPedidoIdFromBase(item.base);
    const categoria = pedido.product_id || pedido.categoria || "";

    return {
      id,
      categoria,
      criado_em: pedido.criado_em || pedido.data_criacao || pedido.created_at || "",
      status: pedido.status || readOrderStatus(item.base, "")
    };
  });

  const categorias = {};
  pedidos.forEach(item => {
    const pedido = item.pedido || {};
    const categoria = pedido.product_id || pedido.categoria || "";
    const nome = nomeCategoriaResumo(categoria);
    categorias[nome] = (categorias[nome] || 0) + 1;
  });

  const categoriasResumo = Object.entries(categorias)
    .map(([nome, total]) => `${nome}: ${total}`)
    .join(" | ");
  const pedidosPagos = pedidos.filter(item => {
    const pedido = item.pedido || {};
    return Boolean(pedido.pagamento_confirmado_em) || pedido.pagamento_info?.status === "approved";
  });
  const valorTotalPago = pedidosPagos.reduce((total, item) => {
    const pedido = item.pedido || {};
    const valorInfo = Number(pedido.pagamento_info?.valor_pago || 0);
    return total + (valorInfo > 0 ? valorInfo : 0);
  }, 0);

  const item = pedidos[0];
  if (!item) {
    return {
      total_pedidos: 0,
      total_pagos: 0,
      valor_total_pago: 0,
      ultimo_pedido: "",
      ultimo_pedido_em: "",
      ultimo_pedido_url: "",
      pedidos_resumo: [],
      categorias_resumo: ""
    };
  }

  const pedido = item.pedido || {};
  const ultimoPedidoId = pedido.id || getPedidoIdFromBase(item.base);

  return {
    total_pedidos: pedidos.length,
    total_pagos: pedidosPagos.length,
    valor_total_pago: Number(valorTotalPago.toFixed(2)),
    ultimo_pedido: ultimoPedidoId,
    ultimo_pedido_em: pedido.criado_em || pedido.data_criacao || pedido.created_at || "",
    ultimo_pedido_url: `/bot/pedidos/${encodeURIComponent(ultimoPedidoId)}/zip`,
    pedidos_resumo: pedidosResumo,
    categorias_resumo: categoriasResumo
  };
}

function clienteUsaApp(cliente) {
  return Number(cliente?.app_uso?.total_acessos_app || 0) > 0;
}

function clienteTemPedidoPwa(whatsapp) {
  return listPedidoBasesByWhatsapp(whatsapp)
    .slice()
    .sort((a, b) => pedidoBaseTimestamp(b) - pedidoBaseTimestamp(a))
    .slice(0, 15)
    .some(item => {
      const pedido = item?.pedido || {};
      return pedido.origem_acesso === "pwa" || pedido.display_mode === "standalone";
    });
}

function clienteTemApp(cliente, whatsapp = "") {
  return cliente?.app_instalado === true || clienteUsaApp(cliente) || clienteTemPedidoPwa(whatsapp);
}

const EVENTOS_INSTALACAO_APP = new Set([
  "clicou_instalar_app",
  "resultado_instalar_app",
  "app_instalado",
  "abriu_modal_instalar_app",
  "uso_app_pwa"
]);

function atualizarPedidosComInstalacaoApp(req, eventos = []) {
  try {
    const whatsapp = req.user?.whatsapp || "";
    if (!whatsapp || !Array.isArray(eventos) || eventos.length === 0) return;

    const eventosApp = eventos.filter(ev => EVENTOS_INSTALACAO_APP.has(ev?.e || ""));
    if (!eventosApp.length) return;

    const agoraIsoGeral = new Date().toISOString();

    try {
      const clientes = readClientes();
      const cliente = clientes[whatsapp];

      if (cliente) {
        let alterouCliente = false;

        cliente.app_instalacao = cliente.app_instalacao || {
          clicou_instalar: false,
          abriu_modal_manual: false,
          tentativas: 0,
          cancelou: 0,
          aceitou_prompt: 0,
          instalado: false,
          ultimo_resultado: "",
          primeira_acao_em: "",
          ultima_acao_em: ""
        };

        eventosApp.forEach(ev => {
          const evento = ev?.e || "";
          const payload = ev?.p || {};

          if (!cliente.app_instalacao.primeira_acao_em) {
            cliente.app_instalacao.primeira_acao_em = agoraIsoGeral;
          }

          cliente.app_instalacao.ultima_acao_em = agoraIsoGeral;

          if (evento === "clicou_instalar_app") {
            cliente.app_instalacao.clicou_instalar = true;
            cliente.app_instalacao.tentativas = Number(cliente.app_instalacao.tentativas || 0) + 1;
            alterouCliente = true;
          }

          if (evento === "abriu_modal_instalar_app") {
            cliente.app_instalacao.abriu_modal_manual = true;
            alterouCliente = true;
          }

          if (evento === "resultado_instalar_app") {
            const resultado = String(payload.resultado || "");
            cliente.app_instalacao.ultimo_resultado = resultado;

            if (resultado === "accepted") {
              cliente.app_instalacao.aceitou_prompt = Number(cliente.app_instalacao.aceitou_prompt || 0) + 1;
            }

            if (resultado === "dismissed") {
              cliente.app_instalacao.cancelou = Number(cliente.app_instalacao.cancelou || 0) + 1;
            }

            alterouCliente = true;
          }

          if (evento === "app_instalado") {
            cliente.app_instalacao.instalado = true;
            cliente.app_instalado = true;
            cliente.app_instalado_em = cliente.app_instalado_em || agoraIsoGeral;
            alterouCliente = true;
          }

          if (evento === "uso_app_pwa") {
            cliente.app_instalado = true;
            cliente.app_instalado_em = cliente.app_instalado_em || agoraIsoGeral;
            cliente.app_instalacao.instalado = true;
            cliente.app_uso = cliente.app_uso || {
              ultimo_acesso_app_em: "",
              total_acessos_app: 0
            };
            cliente.app_uso.ultimo_acesso_app_em = agoraIsoGeral;
            cliente.app_uso.total_acessos_app = Number(cliente.app_uso.total_acessos_app || 0) + 1;
            alterouCliente = true;
          }
        });

        if (alterouCliente) {
          clientes[whatsapp] = cliente;
          writeClientes(clientes);
        }
      }
    } catch {}

    const itens = listPedidoBasesByWhatsapp(whatsapp).slice(0, 20);

    itens.forEach(item => {
      try {
        const pedidoPath = path.join(item.base, "pedido.json");
        const pedido = safeReadJson(pedidoPath) || {};
        let alterou = false;

        const appInstalacao = {
          clicou_instalar: pedido.app_instalacao?.clicou_instalar === true,
          abriu_modal_manual: pedido.app_instalacao?.abriu_modal_manual === true,
          tentativas: Number(pedido.app_instalacao?.tentativas || 0),
          cancelou: Number(pedido.app_instalacao?.cancelou || 0),
          aceitou_prompt: Number(pedido.app_instalacao?.aceitou_prompt || 0),
          instalado: pedido.app_instalacao?.instalado === true,
          ultimo_resultado: pedido.app_instalacao?.ultimo_resultado || "",
          primeira_acao_em: pedido.app_instalacao?.primeira_acao_em || "",
          ultima_acao_em: pedido.app_instalacao?.ultima_acao_em || "",
          ultimo_acesso_app_em: pedido.app_instalacao?.ultimo_acesso_app_em || "",
          total_acessos_app: Number(pedido.app_instalacao?.total_acessos_app || 0)
        };

        eventosApp.forEach(ev => {
          const agoraIso = new Date().toISOString();
          const evento = ev?.e || "";
          const payload = ev?.p || {};

          if (!appInstalacao.primeira_acao_em) {
            appInstalacao.primeira_acao_em = agoraIso;
          }
          appInstalacao.ultima_acao_em = agoraIso;

          if (evento === "clicou_instalar_app") {
            appInstalacao.clicou_instalar = true;
            appInstalacao.tentativas += 1;
            alterou = true;
          }

          if (evento === "abriu_modal_instalar_app") {
            appInstalacao.abriu_modal_manual = true;
            alterou = true;
          }

          if (evento === "resultado_instalar_app") {
            const resultado = String(payload.resultado || "");
            appInstalacao.ultimo_resultado = resultado;

            if (resultado === "accepted") {
              appInstalacao.aceitou_prompt += 1;
            }

            if (resultado === "dismissed") {
              appInstalacao.cancelou += 1;
            }

            alterou = true;
          }

          if (evento === "app_instalado") {
            appInstalacao.instalado = true;
            alterou = true;
          }

          if (evento === "uso_app_pwa") {
            appInstalacao.instalado = true;
            appInstalacao.ultimo_acesso_app_em = agoraIso;
            appInstalacao.total_acessos_app = Number(appInstalacao.total_acessos_app || 0) + 1;
            alterou = true;
          }
        });

        if (alterou) {
          pedido.app_instalacao = appInstalacao;
          writePedido(item.base, pedido);
        }
      } catch {}
    });
  } catch {}
}

function salvarEventosCliente(req, eventos = []) {
  try {
    if (!Array.isArray(eventos) || eventos.length === 0) return;

    const agora = new Date();
    const agoraIso = agora.toISOString();

    const yyyy = agora.getFullYear();
    const mm = String(agora.getMonth() + 1).padStart(2, "0");
    const dd = String(agora.getDate()).padStart(2, "0");

    const analyticsDiaFile = path.join(
      ANALYTICS_DIR,
      `${yyyy}-${mm}-${dd}.json`
    );

    const atuais = readJsonArraySafe(analyticsDiaFile);

    const cliente = req.user ? getClienteResumo(req.user.whatsapp) : null;

    if (
      cliente?.nome_time &&
      CLIENTES_TESTE.includes(cliente.nome_time)
    ) {
      return;
    }

    atualizarPedidosComInstalacaoApp(req, eventos);

    const ultimoEventoPorSessao = {};

    atuais.slice(-300).forEach(ev => {
      if (!ev?.sessao) return;
      ultimoEventoPorSessao[ev.sessao] = ev;
    });

    eventos.forEach(ev => {
      const payload = ev.p || {};
      const pedidoId = String(payload.pedido_id || ev.pedido_id || "").trim();

      const item = {
        data: agoraIso,
        cliente_id: cliente?.cliente_id || "",
        nome_time: cliente?.nome_time || "",
        whatsapp: cliente?.whatsapp || "",
        sessao: ev.sessao || "",
        evento: ev.e || "",
        produto: ev.produto || "",
        categoria: ev.categoria || "",
        pedido_id: pedidoId,
        pagina: ev.url || "",
        logado: !!ev.logado,

        campo_atual: payload.campo_atual || "",
        ultima_acao: payload.ultima_acao || "",
        tempo_inativo_ms: Number(payload.tempo_inativo_ms || 0),

        payload
      };

      const ultimo = ultimoEventoPorSessao[item.sessao];

      if (
        item.evento === "campo_foco" &&
        ultimo &&
        ultimo.evento === "campo_foco" &&
        ultimo.campo_atual === item.campo_atual
      ) {
        return;
      }

      if (
        item.evento === "click_interface" &&
        ultimo &&
        ultimo.evento === "click_interface" &&
        ultimo.campo_atual === item.campo_atual &&
        (new Date(item.data).getTime() - new Date(ultimo.data).getTime()) < 2000
      ) {
        return;
      }

      if (
        item.evento === "usuario_inativo"
      ) {
        const tempo = Number(item.tempo_inativo_ms || 0);

        const faixa =
          tempo >= 900000 ? "15m" :
          tempo >= 300000 ? "5m" :
          tempo >= 60000 ? "1m" :
          "0";

        item.faixa_inatividade = faixa;

        if (
          ultimo &&
          ultimo.evento === "usuario_inativo" &&
          ultimo.faixa_inatividade === faixa
        ) {
          return;
        }
      }

      atuais.push(item);
      ultimoEventoPorSessao[item.sessao] = item;

      if (pedidoId) {
        try {
          const basePedido = getPedidoBaseGlobal(pedidoId);

          if (basePedido) {
            const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
            const eventosPedido = readJsonArraySafe(eventosPedidoFile);

            eventosPedido.push(item);

            const limitePedido = 500;

            if (eventosPedido.length > limitePedido) {
              eventosPedido.splice(0, eventosPedido.length - limitePedido);
            }

            writeJsonSafe(eventosPedidoFile, eventosPedido);
          }
        } catch {}
      }
    });

    const limite = 50000;

    if (atuais.length > limite) {
      atuais.splice(0, atuais.length - limite);
    }

    writeJsonSafe(analyticsDiaFile, atuais);

    const resumo = {
      atualizado_em: agoraIso,
      total_eventos: atuais.length,
      visitas: atuais.filter(e => e.evento === "pagina_aberta").length,
      pedidos_concluidos: atuais.filter(e => e.evento === "pedido_concluido").length,
      downloads: atuais.filter(e => e.evento === "baixou_imagem").length,
      suporte: atuais.filter(e => e.evento === "abriu_suporte").length,
      erros: atuais.filter(e => String(e.evento || "").includes("erro")).length
    };

    writeJsonSafe(
      path.join(ANALYTICS_DIR, "analytics_resumo.json"),
      resumo
    );

  } catch {}
}

function getClienteResumo(whatsapp) {
  const clientes = readClientes();
  const c = clientes[whatsapp] || {};

  return {
    whatsapp,
    cliente_id: whatsapp,
    nome_time: c.nome_time || "",
    login_tipo: c.login_tipo || "whatsapp",
    email: c.email || "",
    foto_google: c.foto_google || "",
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: Number(c.usados_no_ciclo || 0)
  };
}

function registrarOnline(req, extra = {}) {
  try {
    if (!req.user || !req.user.whatsapp) return;

    const online = safeReadJson(ONLINE_FILE) || {};
    const whatsapp = req.user.whatsapp;
    const cliente = getClienteResumo(whatsapp);

    online[whatsapp] = {
      ...cliente,
      online: true,
      ultima_atividade: new Date().toISOString(),
      pagina_atual: extra.pagina_atual || req.headers["x-ia4-page"] || "",
      produto_atual: extra.produto_atual || req.headers["x-ia4-product"] || "",
      chat_aberto: String(extra.chat_aberto ?? req.headers["x-ia4-chat"] ?? "") === "true",
      ultima_acao: extra.ultima_acao || req.headers["x-ia4-action"] || ""
    };

    fs.writeFileSync(ONLINE_FILE, JSON.stringify(online, null, 2), "utf8");
  } catch {}
}

function listarOnlineRecentes() {
  const online = safeReadJson(ONLINE_FILE) || {};
  const eventos = readJsonArraySafe(EVENTOS_CLIENTES_FILE);

  const agora = Date.now();
  const limiteMs = 2 * 60 * 1000;

  const usuarios = Object.values(online)
    .filter(u => {
      const t = new Date(u.ultima_atividade || 0).getTime();
      return t && agora - t <= limiteMs;
    })
    .sort((a, b) => new Date(b.ultima_atividade) - new Date(a.ultima_atividade));

  return usuarios.map(u => {
    const ultimos = eventos
      .filter(ev => ev.whatsapp === u.whatsapp)
      .slice(-30);

    const ultimo = ultimos[ultimos.length - 1] || {};

    return {
      ...u,
      campo_atual: ultimo.campo_atual || "",
      ultima_acao_evento: ultimo.ultima_acao || "",
      tempo_inativo_ms: Number(ultimo.tempo_inativo_ms || 0),
      ultimo_evento: ultimo.evento || ""
    };
  });
}

function salvarMensagemSuporteAberta(whatsapp, mensagemCliente, respostaIA, origem = "ia") {
  finalizarConversasSuporteInativas();

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const cliente = getClienteResumo(whatsapp);

  let conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

  if (!conversa) {
    conversa = {
      id: `${whatsapp}_${Date.now()}`,
      whatsapp,
      cliente,
      inicio: new Date().toISOString(),
      finalizada: false,
      status: "aberta",
      precisa_humano: false,
      cliente_leu: false,
      mensagens: []
    };
    abertas.push(conversa);
  }

  conversa.cliente = cliente;
  conversa.ultima_atualizacao = new Date().toISOString();

  if (mensagemCliente && String(mensagemCliente).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_cliente`,
      data: new Date().toISOString(),
      autor: "cliente",
      texto: String(mensagemCliente || "").trim()
    });

    conversa.cliente_leu = true;
  }

  if (respostaIA && String(respostaIA).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_${origem}`,
      data: new Date().toISOString(),
      autor: origem,
      texto: String(respostaIA || "").trim()
    });

    conversa.cliente_leu = false;
  }

  writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
  return conversa;
}

function finalizarConversaSuporte(whatsapp, motivo) {
  const abertasPath = SUPORTE_ABERTAS_FILE;
  const finalizadasPath = SUPORTE_FINALIZADAS_FILE;

  const abertas = readJsonArraySafe(abertasPath);
  const finalizadas = readJsonArraySafe(finalizadasPath);

  const idx = abertas.findIndex(c => c.whatsapp === whatsapp && !c.finalizada);

  if (idx === -1) return false;

  const conversa = abertas[idx];
  conversa.finalizada = true;
  conversa.fim = new Date().toISOString();
  conversa.motivo_finalizacao = motivo || "finalizacao_automatica";

  finalizadas.push(conversa);
  abertas.splice(idx, 1);

  writeJsonSafe(abertasPath, abertas);
  writeJsonSafe(finalizadasPath, finalizadas);

  return true;
}

function finalizarConversasSuporteInativas() {
  const abertasPath = SUPORTE_ABERTAS_FILE;
  const finalizadasPath = SUPORTE_FINALIZADAS_FILE;

  const abertas = readJsonArraySafe(abertasPath);
  if (abertas.length === 0) return;

  const finalizadas = readJsonArraySafe(finalizadasPath);
  const agora = Date.now();
  const limiteMs = 10 * 60 * 1000;

  const aindaAbertas = [];

  for (const conversa of abertas) {
    const ultima = new Date(conversa.ultima_atualizacao || conversa.inicio || 0).getTime();

    if (ultima && agora - ultima >= limiteMs) {
      conversa.finalizada = true;
      conversa.fim = new Date().toISOString();
      conversa.motivo_finalizacao = "inatividade_10_minutos";
      finalizadas.push(conversa);
    } else {
      aindaAbertas.push(conversa);
    }
  }

  writeJsonSafe(abertasPath, aindaAbertas);
  writeJsonSafe(finalizadasPath, finalizadas);
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Sem token" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

// ===== UPLOAD (multer) =====
const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, path.join(DATA_DIR, "tmp_uploads")),

  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const permitidos = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ];

    if (!permitidos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP são permitidas."));
    }

    cb(null, true);
  }
});

const uploadCartaAppImagem = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CARTAS_APP_IMAGENS_DIR),
    filename: (req, file, cb) => {
      const ext = getExtensaoImagemCarta(file.mimetype);
      const id = String(req.params.id || "").replace(/[^\w.\-]+/g, "_");
      cb(null, `${id}${ext || ".png"}`);
    }
  }),
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const permitidos = new Set([
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ]);

    if (!permitidos.has(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP são permitidas."));
    }

    cb(null, true);
  }
});

const uploadResultado = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const permitidos = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ];

    if (!permitidos.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP sao permitidas."));
    }

    cb(null, true);
  }
});

function uploadComErroControlado(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();

      if (err.code === "LIMIT_FILE_SIZE") {
        console.warn("[UPLOAD_LIMIT] arquivo_maior_50mb", {
          field: err.field || "",
          url: req.originalUrl || req.url || ""
        });
        return res.status(400).json({
          ok: false,
          error: "Arquivo muito grande. Envie imagens com até 50MB."
        });
      }

      console.warn("[UPLOAD_ERROR]", {
        field: err.field || "",
        url: req.originalUrl || req.url || "",
        message: err.message || String(err)
      });
      return res.status(400).json({
        ok: false,
        error: err.message || "Erro ao enviar arquivo."
      });
    });
  };
}

function listarArquivosUpload(files = {}) {
  return Object.values(files || {})
    .flat()
    .filter(file => file && file.path);
}

function limparUploadsTemporarios(files = {}) {
  for (const file of listarArquivosUpload(files)) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (e) {
      console.warn("[UPLOAD_CLEANUP] falha ao remover temporario", {
        field: file.fieldname || "",
        path: file.path || "",
        erro: e.message
      });
    }
  }
}

function appendJsonLineSafe(filePath, payload) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(payload) + "\n", "utf8");
  } catch (e) {
    console.warn("[PRODUCT_AUDIT] falha ao gravar auditoria", {
      arquivo: filePath,
      erro: e.message
    });
  }
}

function readProdutoAuditoriaEntries(limit = 5000) {
  try {
    if (!fs.existsSync(PRODUTO_AUDITORIA_FILE)) return [];

    const linhas = fs.readFileSync(PRODUTO_AUDITORIA_FILE, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const limite = Math.max(1, Math.min(Number(limit || 5000) || 5000, 50000));

    return linhas.slice(-limite).map(linha => {
      try {
        return JSON.parse(linha);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.warn("[PRODUCT_AUDIT] falha ao ler auditoria", {
      arquivo: PRODUTO_AUDITORIA_FILE,
      erro: e.message
    });
    return [];
  }
}

function registrarAuditoriaProdutoPedido({ categoria, fields, files, pedidoId }) {
  const audit = productAuditService.auditProductOrder({ categoria, fields, files });
  const entry = {
    ...audit,
    pedido_id: pedidoId || "",
    registrado_em: new Date().toISOString()
  };

  appendJsonLineSafe(PRODUTO_AUDITORIA_FILE, entry);

  if (entry.total_avisos > 0) {
    console.warn("[PRODUCT_AUDIT]", entry);
  } else {
    console.log("[PRODUCT_AUDIT]", {
      produto: entry.produto,
      pedido_id: entry.pedido_id,
      total_avisos: 0
    });
  }

  return entry;
}

// ===== ROTAS =====

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "omascote-api online" });
});

app.get("/tempo-estimado", (req, res) => {
  return res.json({
    ok: true,
    ...readTempoEstimado()
  });
});

app.post("/evento", (req, res) => {
  try {
    const eventos = Array.isArray(req.body?.eventos)
      ? req.body.eventos
      : [];

    let clienteFake = null;

    try {
      const h = req.headers.authorization || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : "";

      if (token) {
        clienteFake = jwt.verify(token, JWT_SECRET);
      }
    } catch {}

    salvarEventosCliente(
      { user: clienteFake },
      eventos
    );

    return res.json({ ok:true });
  } catch {
    return res.status(500).json({
      ok:false,
      error:"erro_eventos"
    });
  }
});

app.post("/bot/tempo-estimado", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const payload = req.body || {};

  const tempo = {
    tempo_medio_segundos: Number(payload.tempo_medio_segundos ?? 0),
    tempo_estimado_segundos: Number(payload.tempo_estimado_segundos ?? 0),
    pedidos_na_fila: Number(payload.pedidos_na_fila || 0),
    lotes: Number(payload.lotes || 1),
    max_processos: Number(payload.max_processos || 5),
    atualizado_em: payload.atualizado_em || new Date().toISOString()
  };

  writeTempoEstimado(tempo);

  return res.json({ ok: true });
});

async function verificarGoogleIdToken(id_token) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID não configurado");
  }

  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(id_token));
  const data = await r.json();

  if (!r.ok || data.aud !== GOOGLE_CLIENT_ID || !data.sub) {
    throw new Error("Token Google inválido");
  }

  return data;
}

app.get("/auth/google-config", (req, res) => {
  return res.json({
    ok: true,
    client_id: GOOGLE_CLIENT_ID
  });
});

app.post("/auth/google", async (req, res) => {
  try {
    const { id_token } = req.body || {};

    if (!id_token) {
      return res.status(400).json({ ok: false, error: "id_token obrigatório" });
    }

    const google = await verificarGoogleIdToken(id_token);
    const clientes = readClientes();

    const chaveCliente = "google_" + String(google.sub).replace(/[^\w\-]+/g, "");
    const nomeGoogle = google.name || google.given_name || "Meu time";
    const emailGoogle = google.email || "";

    let c = clientes[chaveCliente];

    if (!c) {
      c = {
        nome_time: nomeGoogle,
        senha_hash: "",
        login_tipo: "google",
        google_id: google.sub,
        email: emailGoogle,
        foto_google: google.picture || "",
        plano: 0,
        saldo_mensal: 0,
        saldo_extra: 0,
        usados_no_ciclo: 0,
        ciclo_mes: nowYYYYMM(),
        ativo: true
      };

      clientes[chaveCliente] = c;
      writeClientes(clientes);
    }

    const mesAtual = nowYYYYMM();
    if (c.ciclo_mes !== mesAtual) {
      c.ciclo_mes = mesAtual;
      c.usados_no_ciclo = 0;
      clientes[chaveCliente] = c;
      writeClientes(clientes);
    }

    const token = jwt.sign({ whatsapp: chaveCliente }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      ok: true,
      token,
      nome_time: c.nome_time,
      plano: c.plano,
      saldo_mensal: Number(c.saldo_mensal || 0),
      saldo_extra: Number(c.saldo_extra || 0),
      saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
      usados_no_ciclo: c.usados_no_ciclo
    });

  } catch (e) {
    return res.status(401).json({
      ok: false,
      error: e.message || "Erro ao entrar com Google"
    });
  }
});

// Login automático invisível
app.post("/auth/auto-register", (req, res) => {
  try {
    const body = req.body || {};
    const clientes = readClientes();

    const nome_time = String(
      body.nome_time ||
      body.nome_jogador ||
      body.login ||
      "Jogador"
    ).trim();

    const produtoOrigem = String(body.produto || "");
    const creditoPreviewInterno = getCustoPedido(produtoOrigem, null);
    const login = criarLoginAutomaticoUnico(body.login || nome_time, clientes);
    const senhaCliente = gerarSenhaAutomatica();
    const senha_hash = bcrypt.hashSync(senhaCliente, 8);

    const novo = {
      nome_time: nome_time || "Jogador",
      senha_hash,
      login_tipo: "automatico",
      cadastro_automatico: true,
      conta_finalizada: false,
      produto_origem: produtoOrigem,
      credito_preview_interno: Number(creditoPreviewInterno || 0),
      device_id: String(body.device_id || ""),
      plano: 0,
      saldo_mensal: 0,
      saldo_extra: 0,
      usados_no_ciclo: 0,
      ciclo_mes: nowYYYYMM(),
      ativo: true,
      criado_em: new Date().toISOString()
    };

    clientes[login] = novo;
    writeClientes(clientes);

    const token = jwt.sign({ whatsapp: login }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      ok: true,
      token,
      login,
      whatsapp: login,
      nome_time: novo.nome_time,
      plano: novo.plano,
      saldo_mensal: Number(novo.saldo_mensal || 0),
      saldo_extra: Number(novo.saldo_extra || 0),
      saldo: Number(novo.saldo_mensal || 0) + Number(novo.saldo_extra || 0),
      usados_no_ciclo: novo.usados_no_ciclo
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Erro ao criar acesso automático."
    });
  }
});

// Login
app.post("/auth/register", (req, res) => {
  const body = req.body || {};
  const whatsapp = normalizarLoginId(body.whatsapp);
  const senha = body.senha || "";
  const nome_time = String(body.nome_time || whatsapp || "").trim();

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "login e senha obrigatórios" });
  }

  if (whatsapp.length < 3) {
    return res.status(400).json({ ok: false, error: "Login muito curto" });
  }

  const clientes = readClientes();

  if (clientes[whatsapp]) {
    return res.status(400).json({
      ok: false,
      error: `Esse login já existe. Tente algo como: ${whatsapp}${Math.floor(Math.random()*99)}`
    });
  }

  const senha_hash = bcrypt.hashSync(senha, 8);

  const novo = {
    nome_time,
    senha_hash,
    plano: 0,
    saldo_mensal: 0,
    saldo_extra: 0,
    usados_no_ciclo: 0,
    ciclo_mes: nowYYYYMM(),
    ativo: true
  };

  const clientesAtualizados = readClientes();

  if (clientesAtualizados[whatsapp]) {
    return res.status(400).json({
      ok: false,
      error: `Esse login já existe. Tente outro nome.`
    });
  }

  clientesAtualizados[whatsapp] = novo;
  writeClientes(clientesAtualizados);

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn: "7d" });

  return res.json({
    ok: true,
    token,
    nome_time: novo.nome_time,
    plano: novo.plano,
    usados_no_ciclo: novo.usados_no_ciclo
  });
});

app.post("/auth/finalizar-conta-auto", auth, (req, res) => {
  try {
    const loginAtual = req.user.whatsapp;
    const novoLogin = normalizarLoginId(req.body?.login);
    const senha = String(req.body?.senha || "");

    if (!novoLogin || novoLogin.length < 3) {
      return res.status(400).json({ ok:false, error:"Login muito curto" });
    }

    if (!senha || senha.length < 3) {
      return res.status(400).json({ ok:false, error:"Senha muito curta" });
    }

    const clientes = readClientes();
    const clienteAtual = clientes[loginAtual];

    if (!clienteAtual) {
      return res.status(404).json({ ok:false, error:"Conta automática não encontrada" });
    }

    if (clienteAtual.cadastro_automatico !== true || clienteAtual.conta_finalizada === true) {
      return res.status(400).json({ ok:false, error:"Essa conta já foi finalizada" });
    }

    if (clientes[novoLogin] && novoLogin !== loginAtual) {
      return res.status(400).json({
        ok:false,
        error:`Esse login já existe. Tente algo como: ${novoLogin}${Math.floor(Math.random()*99)}`
      });
    }

    clienteAtual.nome_time = novoLogin;
    clienteAtual.senha_hash = bcrypt.hashSync(senha, 8);
    clienteAtual.conta_finalizada = true;
    clienteAtual.finalizado_em = new Date().toISOString();

    if (novoLogin !== loginAtual) {
      clientes[novoLogin] = clienteAtual;
      delete clientes[loginAtual];

      try {
        const pastaAntiga = path.join(PEDIDOS_DIR, loginAtual);
        const pastaNova = path.join(PEDIDOS_DIR, novoLogin);

        if (fs.existsSync(pastaAntiga) && !fs.existsSync(pastaNova)) {
          fs.renameSync(pastaAntiga, pastaNova);
        }
      } catch {}
    } else {
      clientes[loginAtual] = clienteAtual;
    }

    writeClientes(clientes);

    const token = jwt.sign({ whatsapp: novoLogin }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      ok:true,
      token,
      whatsapp: novoLogin,
      nome_time: clienteAtual.nome_time,
      plano: clienteAtual.plano,
      saldo_mensal: Number(clienteAtual.saldo_mensal || 0),
      saldo_extra: Number(clienteAtual.saldo_extra || 0),
      saldo: Number(clienteAtual.saldo_mensal || 0) + Number(clienteAtual.saldo_extra || 0),
      usados_no_ciclo: clienteAtual.usados_no_ciclo
    });

  } catch (e) {
    return res.status(500).json({
      ok:false,
      error:"Erro ao finalizar conta automática"
    });
  }
});

app.post("/auth/login", (req, res) => {
  const body = req.body || {};
  const whatsapp = normalizarLoginId(body.whatsapp);
  const senha = body.senha || "";

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "login e senha obrigatórios" });
  }

  const clientes = readClientes();
  const c = clientes[whatsapp];

  if (!c) {
    return res.status(401).json({ ok: false, error: "Login não encontrado" });
  }

  if (!c.ativo) {
    return res.status(403).json({ ok: false, error: "Mensalidade inativa" });
  }

  const ok = bcrypt.compareSync(senha, c.senha_hash);
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Senha incorreta" });
  }

  const mesAtual = nowYYYYMM();
  if (c.ciclo_mes !== mesAtual) {
    c.ciclo_mes = mesAtual;
    c.usados_no_ciclo = 0;
    clientes[whatsapp] = c;
    writeClientes(clientes);
  }

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn: "7d" });

  return res.json({
    ok: true,
    token,
    nome_time: c.nome_time,
    plano: c.plano,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: c.usados_no_ciclo
  });
});

// Perfil
app.get("/me", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil" });

  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
  }

  let perfilId = normalizarPerfilId(c.perfil_id);

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    perfilId = perfilInfo.perfil_id;
  } catch (err) {
    console.warn("[perfil] falha ao garantir perfil no /me", {
      cliente_id: req.user.whatsapp,
      erro: err?.message || err
    });
  }

  return res.json({
    ok: true,
    perfil_id: perfilId,
    nome_time: c.nome_time,
    plano: c.plano,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: c.usados_no_ciclo,
    brinde_mascote_disponivel: c.brinde_mascote_disponivel === true,
    brinde_escudo3d_app_disponivel: (
      c.brinde_escudo3d_app_usado !== true &&
      Number(c.usados_no_ciclo || 0) === 0 &&
      Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0) <= 0 &&
      c.brinde_mascote_ja_liberado !== true &&
      listPedidoBasesByWhatsapp(req.user.whatsapp).length === 0
    ),
    brinde_escudo3d_app_usado: c.brinde_escudo3d_app_usado === true,
    ativo: c.ativo
  });
});

function carregarPerfilTimePrivado(req, res) {
  registrarOnline(req, { ultima_acao: "perfil_time" });

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);

    return res.json({
      ok: true,
      perfil: perfilResponse(perfilInfo.perfil)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar perfil"
    });
  }
}

function salvarPerfilTimePrivado(req, res) {
  registrarOnline(req, { ultima_acao: "perfil_time_editar" });

  const clientes = readClientes();
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};

  if (Object.prototype.hasOwnProperty.call(body, "nome_time") && !textoPerfil(body.nome_time)) {
    return res.status(400).json({
      ok: false,
      error: "Nome do time obrigatorio"
    });
  }

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const perfilAtual = safeReadJson(perfilInfo.perfil_file) || perfilInfo.perfil;
    const agora = new Date().toISOString();

    const perfil = normalizarPerfilPrivado({
      ...perfilAtual,
      nome_time: textoPerfil(body.nome_time ?? perfilAtual.nome_time),
      cidade: textoPerfil(body.cidade ?? perfilAtual.cidade),
      estado: textoPerfil(body.estado ?? perfilAtual.estado, 40),
      instagram: normalizarInstagramPerfil(body.instagram ?? perfilAtual.instagram),
      escudo_url: assetPerfil(body.escudo_url ?? perfilAtual.escudo_url),
      escudo_path: assetPerfil(body.escudo_path ?? perfilAtual.escudo_path),
      mascote_url: assetPerfil(body.mascote_url ?? perfilAtual.mascote_url),
      mascote_path: assetPerfil(body.mascote_path ?? perfilAtual.mascote_path),
      descricao_curta: textoPerfil(body.descricao_curta ?? perfilAtual.descricao_curta, 240),
      publico: false,
      atualizado_em: agora
    }, perfilInfo.cliente, perfilInfo.perfil_id);

    perfil.publico = false;
    perfil.atualizado_em = agora;

    perfilInfo.cliente.perfil_id = perfilInfo.perfil_id;
    perfilInfo.cliente.nome_time = perfil.nome_time || perfilInfo.cliente.nome_time;
    clientes[req.user.whatsapp] = perfilInfo.cliente;

    writeJsonSafe(perfilInfo.perfil_file, perfil);
    writeClientes(clientes);

    return res.json({
      ok: true,
      perfil: perfilResponse(perfil)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao salvar perfil"
    });
  }
}

app.get("/me/perfil", auth, carregarPerfilTimePrivado);
app.patch("/me/perfil", auth, salvarPerfilTimePrivado);
app.get("/me/time/perfil", auth, carregarPerfilTimePrivado);
app.patch("/me/time/perfil", auth, salvarPerfilTimePrivado);

app.get("/me/time/jogadores", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogadores" });

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id);

    return res.json({
      ok: true,
      jogadores: jogadores.map(jogadorResponse)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar elenco"
    });
  }
});

app.post("/me/time/jogadores", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogador_criar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const nome = textoPerfil(body.nome || "", 80);

  if (!nome) {
    return res.status(400).json({
      ok: false,
      error: "Nome do jogador obrigatorio"
    });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id);
    const jogador = payloadJogador({
      ...body,
      nome,
      ativo: true
    }, {
      id: gerarJogadorId(),
      ativo: true
    });

    jogadores.push(jogador);
    writePerfilJogadores(perfilInfo.perfil_id, jogadores);

    return res.status(201).json({
      ok: true,
      jogador: jogadorResponse(jogador)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao criar jogador"
    });
  }
});

app.patch("/me/time/jogadores/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogador_editar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const jogadorId = normalizarJogadorId(req.params.id);

  if (!jogadorId) {
    return res.status(400).json({ ok: false, error: "Jogador invalido" });
  }

  if (Object.prototype.hasOwnProperty.call(body, "nome") && !textoPerfil(body.nome, 80)) {
    return res.status(400).json({
      ok: false,
      error: "Nome do jogador obrigatorio"
    });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id);
    const index = jogadores.findIndex(jogador => jogador.id === jogadorId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Jogador nao encontrado" });
    }

    const jogador = payloadJogador(body, jogadores[index]);
    jogador.id = jogadores[index].id;
    jogador.criado_em = jogadores[index].criado_em;
    jogadores[index] = jogador;
    writePerfilJogadores(perfilInfo.perfil_id, jogadores);

    return res.json({
      ok: true,
      jogador: jogadorResponse(jogador)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao editar jogador"
    });
  }
});

app.delete("/me/time/jogadores/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogador_remover" });

  const jogadorId = normalizarJogadorId(req.params.id);

  if (!jogadorId) {
    return res.status(400).json({ ok: false, error: "Jogador invalido" });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id);
    const index = jogadores.findIndex(jogador => jogador.id === jogadorId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Jogador nao encontrado" });
    }

    jogadores[index] = {
      ...jogadores[index],
      ativo: false,
      atualizado_em: new Date().toISOString()
    };
    writePerfilJogadores(perfilInfo.perfil_id, jogadores);

    return res.json({
      ok: true,
      jogador: jogadorResponse(jogadores[index])
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao remover jogador"
    });
  }
});

app.get("/me/time/jogos", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogos" });

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogos = readPerfilJogos(perfilInfo.perfil_id);

    return res.json({
      ok: true,
      jogos: jogos.map(jogoResponse)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar jogos"
    });
  }
});

app.post("/me/time/jogos", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogo_criar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const tipo = normalizarTipoJogo(body.tipo);
  const adversario = textoPerfil(body.adversario || "", 80);

  if (!tipo) {
    return res.status(400).json({
      ok: false,
      error: "Tipo de jogo invalido"
    });
  }

  if (!adversario) {
    return res.status(400).json({
      ok: false,
      error: "Adversario obrigatorio"
    });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogos = readPerfilJogos(perfilInfo.perfil_id);
    const jogo = payloadJogo({
      ...body,
      tipo,
      adversario,
      ativo: true
    }, {
      id: gerarJogoId(),
      ativo: true
    });

    jogos.push(jogo);
    writePerfilJogos(perfilInfo.perfil_id, jogos);

    return res.status(201).json({
      ok: true,
      jogo: jogoResponse(jogo)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao criar jogo"
    });
  }
});

app.patch("/me/time/jogos/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogo_editar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const jogoId = normalizarJogoId(req.params.id);

  if (!jogoId) {
    return res.status(400).json({ ok: false, error: "Jogo invalido" });
  }

  if (Object.prototype.hasOwnProperty.call(body, "tipo") && !normalizarTipoJogo(body.tipo)) {
    return res.status(400).json({
      ok: false,
      error: "Tipo de jogo invalido"
    });
  }

  if (Object.prototype.hasOwnProperty.call(body, "adversario") && !textoPerfil(body.adversario, 80)) {
    return res.status(400).json({
      ok: false,
      error: "Adversario obrigatorio"
    });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogos = readPerfilJogos(perfilInfo.perfil_id);
    const index = jogos.findIndex(jogo => jogo.id === jogoId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Jogo nao encontrado" });
    }

    const jogo = payloadJogo({
      ...body,
      tipo: Object.prototype.hasOwnProperty.call(body, "tipo")
        ? normalizarTipoJogo(body.tipo)
        : jogos[index].tipo
    }, jogos[index]);
    jogo.id = jogos[index].id;
    jogo.criado_em = jogos[index].criado_em;
    jogos[index] = jogo;
    writePerfilJogos(perfilInfo.perfil_id, jogos);

    return res.json({
      ok: true,
      jogo: jogoResponse(jogo)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao editar jogo"
    });
  }
});

app.delete("/me/time/jogos/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_jogo_remover" });

  const jogoId = normalizarJogoId(req.params.id);

  if (!jogoId) {
    return res.status(400).json({ ok: false, error: "Jogo invalido" });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogos = readPerfilJogos(perfilInfo.perfil_id);
    const index = jogos.findIndex(jogo => jogo.id === jogoId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Jogo nao encontrado" });
    }

    jogos[index] = {
      ...jogos[index],
      ativo: false,
      atualizado_em: new Date().toISOString()
    };
    writePerfilJogos(perfilInfo.perfil_id, jogos);

    return res.json({
      ok: true,
      jogo: jogoResponse(jogos[index])
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao remover jogo"
    });
  }
});

app.get("/cartas-app/ativas", auth, (req, res) => {
  try {
    const clientes = readClientes();
    const cliente = clientes[req.user.whatsapp];

    if (!cliente) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
    }

    const cartasLidas = Array.isArray(cliente.cartas_lidas) ? cliente.cartas_lidas.map(String) : [];
    const cartas = readCartasApp()
      .filter(carta => carta?.ativo === true)
      .filter(carta => carta?.somente_app !== false)
      .filter(carta => cartaAppPermitidaParaCliente(carta, req.user.whatsapp))
      .map(carta => sanitizeCartaApp(carta, cartasLidas))
      .filter(Boolean);

    return res.json({ ok: true, cartas });
  } catch {
    return res.status(500).json({ ok: false, error: "erro_cartas_app" });
  }
});

app.post("/cartas-app/:id/lida", auth, (req, res) => {
  try {
    const carta = getCartaAppAtivaById(req.params.id);
    if (!carta) {
      return res.status(404).json({ ok: false, error: "Carta não encontrada" });
    }

    const clientes = readClientes();
    const cliente = clientes[req.user.whatsapp];

    if (!cliente) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
    }

    const cartaId = String(carta.id || "");
    const cartasLidasAntes = Array.isArray(cliente.cartas_lidas) ? [...cliente.cartas_lidas] : [];
    const leiturasAntes = cliente.cartas_app_leituras && typeof cliente.cartas_app_leituras === "object"
      ? { ...cliente.cartas_app_leituras }
      : {};
    console.log("[cartas-app:lida] antes", {
      cartaId,
      cliente_id: String(cliente.id || req.user.whatsapp || ""),
      whatsapp: req.user.whatsapp,
      cartas_lidas: cartasLidasAntes,
      cartas_app_leituras: leiturasAntes
    });

    cliente.cartas_lidas = Array.isArray(cliente.cartas_lidas) ? cliente.cartas_lidas.map(String) : [];
    cliente.cartas_app_leituras = cliente.cartas_app_leituras && typeof cliente.cartas_app_leituras === "object"
      ? cliente.cartas_app_leituras
      : {};

    if (!cliente.cartas_lidas.includes(cartaId)) {
      cliente.cartas_lidas.push(cartaId);
    }

    if (cliente.cartas_app_leituras[cartaId]?.lida !== true) {
      cliente.cartas_app_leituras[cartaId] = {
        lida: true,
        lida_em: new Date().toISOString()
      };
    }

    clientes[req.user.whatsapp] = cliente;
    writeClientes(clientes);

    console.log("[cartas-app:lida] depois", {
      cartaId,
      cliente_id: String(cliente.id || req.user.whatsapp || ""),
      whatsapp: req.user.whatsapp,
      cartas_lidas: cliente.cartas_lidas,
      cartas_app_leituras: cliente.cartas_app_leituras
    });

    return res.json({
      ok: true,
      carta_id: cartaId,
      lida: true,
      lida_em: cliente.cartas_app_leituras[cartaId]?.lida_em || ""
    });
  } catch {
    return res.status(500).json({ ok: false, error: "erro_marcar_carta_lida" });
  }
});

app.get("/bot/cartas-app/:id/leituras", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const cartaId = String(req.params.id || "").trim();
    const carta = readCartasApp().find(carta => String(carta?.id || "") === cartaId) || null;
    const cartaExiste = !!carta;

    if (!cartaId || !cartaExiste) {
      return res.status(404).json({ ok: false, error: "Carta não encontrada" });
    }

    const clientes = readClientes();
    const leituras = Object.entries(clientes).map(([clienteId, cliente]) => {
      const cartasLidas = Array.isArray(cliente?.cartas_lidas) ? cliente.cartas_lidas.map(String) : [];
      const leitura = cliente?.cartas_app_leituras?.[cartaId] || null;
      const origem = [
        cartasLidas.includes(cartaId) ? "cartas_lidas" : "",
        leitura?.lida === true ? "cartas_app_leituras" : ""
      ].filter(Boolean);
      const lida = origem.length > 0;

      if (!lida) return null;

      return {
        cliente_id: String(clienteId || ""),
        nome_time: String(cliente?.nome_time || ""),
        lida: true,
        lida_em: leitura?.lida_em || "",
        origem
      };
    }).filter(Boolean);

    console.log("[cartas-app:leituras]", {
      carta_id: cartaId,
      clientes_lidos: leituras.map(item => ({
        cliente_id: item.cliente_id,
        lida_em: item.lida_em,
        origem: item.origem
      }))
    });

    return res.json({
      ok: true,
      carta_id: cartaId,
      publico: {
        todos: carta?.publico?.todos === true,
        clientes_ids: Array.isArray(carta?.publico?.clientes_ids)
          ? carta.publico.clientes_ids.map(id => String(id || "").trim()).filter(Boolean)
          : []
      },
      leituras
    });
  } catch {
    return res.status(500).json({ ok: false, error: "erro_leituras_carta_app" });
  }
});

app.get("/bot/cartas-app/:id/debug-leituras", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const cartaId = String(req.params.id || "").trim();
    const carta = readCartasApp().find(carta => String(carta?.id || "") === cartaId) || null;

    if (!cartaId || !carta) {
      return res.status(404).json({ ok: false, error: "Carta não encontrada" });
    }

    const clientes = readClientes();
    const publico = {
      todos: carta?.publico?.todos === true,
      clientes_ids: Array.isArray(carta?.publico?.clientes_ids)
        ? carta.publico.clientes_ids.map(id => String(id || "").trim()).filter(Boolean)
        : []
    };
    const idsParaDebug = publico.clientes_ids.length ? publico.clientes_ids : Object.keys(clientes);

    const clientesDebug = idsParaDebug.map(clienteId => {
      const id = String(clienteId || "").trim();
      const cliente = clientes[id] || {};
      return {
        id,
        nome_time: String(cliente?.nome_time || ""),
        cartas_lidas: Array.isArray(cliente?.cartas_lidas) ? cliente.cartas_lidas.map(String) : [],
        cartas_app_leituras: cliente?.cartas_app_leituras && typeof cliente.cartas_app_leituras === "object"
          ? cliente.cartas_app_leituras
          : {}
      };
    });

    return res.json({
      ok: true,
      carta_id: cartaId,
      publico,
      clientes_ids: publico.clientes_ids,
      clientes: clientesDebug
    });
  } catch {
    return res.status(500).json({ ok: false, error: "erro_debug_leituras_carta_app" });
  }
});

app.get("/admin/auditoria-produtos", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const limit = Math.max(1, Math.min(Number(req.query.limit || 5000) || 5000, 50000));
    const entries = readProdutoAuditoriaEntries(limit);
    const resumo = productAuditService.summarizeAuditEntries(entries);

    return res.json({
      ok: true,
      modo: "log",
      arquivo: PRODUTO_AUDITORIA_FILE,
      limite: limit,
      ...resumo
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Erro ao gerar relatorio de auditoria." });
  }
});

app.get("/admin/cupons", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return res.json({
      ok: true,
      cupons: readCupons()
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Erro ao listar cupons." });
  }
});

app.post("/admin/cupons", auth, (req, res) => {
  let lockAtivo = false;

  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const codigo = normalizarCupomCodigo(req.body?.codigo);
    const cupom = normalizarCupomParaArmazenamento(codigo, req.body || {});

    lockAtivo = adquirirLockCupons();
    if (!lockAtivo) {
      return res.status(409).json({ ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." });
    }

    const cupons = readCupons();

    if (cupons[codigo]) {
      return res.status(409).json({ ok: false, error: "Cupom ja existe." });
    }

    cupons[codigo] = cupom;
    writeCupons(cupons);

    return res.status(201).json({ ok: true, codigo, cupom });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || "Erro ao criar cupom." });
  } finally {
    if (lockAtivo) liberarLockCupons();
  }
});

app.post("/admin/cupons/gerar", auth, (req, res) => {
  let lockAtivo = false;

  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const quantidade = Math.max(1, Math.min(100, Math.floor(Number(req.body?.quantidade || 1))));
    const codigoManual = normalizarCupomCodigo(req.body?.codigo);
    const prefixo = req.body?.prefixo || codigoManual || "PROMO";

    if (codigoManual && quantidade > 1) {
      return res.status(400).json({ ok: false, error: "Codigo manual so pode gerar 1 cupom. Para varios cupons, deixe o codigo em branco e use prefixo." });
    }

    lockAtivo = adquirirLockCupons();
    if (!lockAtivo) {
      return res.status(409).json({ ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." });
    }

    const cupons = readCupons();
    const criados = [];

    for (let i = 0; i < quantidade; i += 1) {
      let codigoPublico = codigoManual ? cupomCodigoPublico(codigoManual) : gerarCodigoCupomAutomatico(prefixo);
      let codigo = normalizarCupomCodigo(codigoPublico);
      let tentativas = 0;

      while (cupons[codigo]) {
        if (codigoManual) {
          return res.status(409).json({ ok: false, error: "Cupom ja existe." });
        }
        codigoPublico = gerarCodigoCupomAutomatico(prefixo);
        codigo = normalizarCupomCodigo(codigoPublico);
        tentativas += 1;
        if (tentativas > 20) {
          return res.status(500).json({ ok: false, error: "Nao foi possivel gerar codigos unicos." });
        }
      }

      const cupom = normalizarCupomParaArmazenamento(codigo, {
        ...req.body,
        codigo: codigoPublico,
        limite_usos_total: req.body?.limite_usos_total || 1,
        usos_total: 0,
        usos_por_cliente: {}
      });

      cupons[codigo] = cupom;
      criados.push({ codigo, cupom });
    }

    writeCupons(cupons);

    return res.status(201).json({ ok: true, quantidade: criados.length, cupons: criados });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || "Erro ao gerar cupons." });
  } finally {
    if (lockAtivo) liberarLockCupons();
  }
});

app.patch("/admin/cupons/:codigo", auth, (req, res) => {
  let lockAtivo = false;

  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const codigo = normalizarCupomCodigo(req.params.codigo);

    lockAtivo = adquirirLockCupons();
    if (!lockAtivo) {
      return res.status(409).json({ ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." });
    }

    const cupons = readCupons();
    const existente = cupons[codigo];

    if (!existente) {
      return res.status(404).json({ ok: false, error: "Cupom nao encontrado." });
    }

    const cupom = normalizarCupomParaArmazenamento(codigo, req.body || {}, { parcial: true, existente });
    cupons[codigo] = cupom;
    writeCupons(cupons);

    return res.json({ ok: true, codigo, cupom });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message || "Erro ao editar cupom." });
  } finally {
    if (lockAtivo) liberarLockCupons();
  }
});

app.post("/admin/cupons/:codigo/desativar", auth, (req, res) => {
  let lockAtivo = false;

  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const codigo = normalizarCupomCodigo(req.params.codigo);

    lockAtivo = adquirirLockCupons();
    if (!lockAtivo) {
      return res.status(409).json({ ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." });
    }

    const cupons = readCupons();

    if (!cupons[codigo]) {
      return res.status(404).json({ ok: false, error: "Cupom nao encontrado." });
    }

    cupons[codigo].ativo = false;
    cupons[codigo].atualizado_em = new Date().toISOString();
    writeCupons(cupons);

    return res.json({ ok: true, codigo, cupom: cupons[codigo] });
  } catch {
    return res.status(500).json({ ok: false, error: "Erro ao desativar cupom." });
  } finally {
    if (lockAtivo) liberarLockCupons();
  }
});

app.post("/admin/cupons/:codigo/ativar", auth, (req, res) => {
  let lockAtivo = false;

  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const codigo = normalizarCupomCodigo(req.params.codigo);

    lockAtivo = adquirirLockCupons();
    if (!lockAtivo) {
      return res.status(409).json({ ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." });
    }

    const cupons = readCupons();

    if (!cupons[codigo]) {
      return res.status(404).json({ ok: false, error: "Cupom nao encontrado." });
    }

    cupons[codigo].ativo = true;
    cupons[codigo].atualizado_em = new Date().toISOString();
    writeCupons(cupons);

    return res.json({ ok: true, codigo, cupom: cupons[codigo] });
  } catch {
    return res.status(500).json({ ok: false, error: "Erro ao ativar cupom." });
  } finally {
    if (lockAtivo) liberarLockCupons();
  }
});

app.post("/bot/cupons-jogador-escudo", auth, (req, res) => {
  let lockAtivo = false;

  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const codigo = normalizarCupomCodigo(req.body?.codigo);

    if (!codigo || codigo.length < 3) {
      return res.status(400).json({ ok: false, error: "Código de cupom inválido." });
    }

    lockAtivo = adquirirLockCupomJogadorEscudo();

    if (!lockAtivo) {
      return res.status(409).json({ ok: false, error: "Arquivo de cupons em uso. Tente novamente em alguns segundos." });
    }

    const cupons = readCuponsJogadorEscudo();

    if (cupons[codigo]) {
      return res.status(409).json({ ok: false, error: "Cupom já existe." });
    }

    const cupom = {
      ativo: true,
      usado: false
    };

    cupons[codigo] = cupom;
    writeCuponsJogadorEscudo(cupons);

    return res.json({
      ok: true,
      codigo,
      cupom
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Erro ao criar cupom." });
  } finally {
    if (lockAtivo) liberarLockCupomJogadorEscudo();
  }
});

app.get("/bot/clientes-arte-semana", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const somenteApp = String(req.query.somente_app || "") === "1";
    const limit = Math.max(1, Math.min(Number(req.query.limit || 100) || 100, 500));
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const clientes = readClientes();
    const ids = Object.keys(clientes).sort();

    const filtrados = ids
      .map(id => {
        const cliente = clientes[id] || {};
        const temPedidoPwa = clienteTemPedidoPwa(id);
        const usaApp = clienteUsaApp(cliente) || temPedidoPwa;
        const temApp = clienteTemApp(cliente, id);

        return {
          id,
          cliente,
          usa_app: usaApp,
          tem_app: temApp
        };
      })
      .filter(item => !somenteApp || item.tem_app);

    const pagina = filtrados.slice(offset, offset + limit);
    const itens = pagina.map(item => {
      const resumoPedido = getUltimoPedidoCliente(item.id);
      const escudo = encontrarEscudoPrincipalCliente(item.id);

      return {
        id: item.id,
        nome_time: item.cliente.nome_time || "",
        usa_app: item.usa_app,
        app_instalado: item.cliente.app_instalado === true || item.tem_app,
        tem_app: item.tem_app,
        total_pedidos: resumoPedido.total_pedidos,
        total_pagos: resumoPedido.total_pagos,
        valor_total_pago: resumoPedido.valor_total_pago,
        ultimo_pedido: resumoPedido.ultimo_pedido,
        ultimo_pedido_em: resumoPedido.ultimo_pedido_em,
        ultimo_pedido_url: resumoPedido.ultimo_pedido_url,
        pedidos_resumo: resumoPedido.pedidos_resumo,
        categorias_resumo: resumoPedido.categorias_resumo,
        escudo: escudo.encontrado
          ? {
              encontrado: true,
              pedido_id: escudo.pedido_id,
              arquivo: escudo.arquivo,
              url: `/bot/clientes/${encodeURIComponent(item.id)}/escudo-principal`,
              caminho_relativo: escudo.caminho_relativo
            }
          : {
              encontrado: false,
              pedido_id: "",
              arquivo: "",
              url: "",
              caminho_relativo: ""
            }
      };
    });

    return res.json({
      ok: true,
      total: filtrados.length,
      limit,
      offset,
      itens
    });
  } catch {
    return res.status(500).json({ ok: false, error: "erro_clientes_arte_semana" });
  }
});

app.get("/bot/clientes/:id/escudo-principal", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const clienteId = String(req.params.id || "").trim();
    const clientes = readClientes();

    if (!clienteId || !clientes[clienteId]) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
    }

    const escudo = encontrarEscudoPrincipalCliente(clienteId);

    if (!escudo.encontrado || !escudo.path || !fs.existsSync(escudo.path)) {
      return res.status(404).json({ ok: false, error: "Escudo não encontrado" });
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${escudo.arquivo}"`);
    return res.sendFile(escudo.path);
  } catch {
    return res.status(500).json({ ok: false, error: "erro_escudo_principal" });
  }
});

app.post("/bot/cartas-app", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const cartas = readCartasApp();
    const carta = normalizarCartaAppPayload(req.body || {});

    cartas.push(carta);
    writeCartasApp(cartas);

    return res.json({
      ok: true,
      carta,
      imagem_url_cliente: `/cartas-app/${encodeURIComponent(carta.id)}/imagem`
    });
  } catch {
    return res.status(500).json({ ok: false, error: "erro_criar_carta_app" });
  }
});

app.post("/bot/cartas-app/:id/imagem", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  uploadCartaAppImagem.single("imagem")(req, res, err => {
    try {
      if (err) {
        return res.status(400).json({ ok: false, error: err.message || "erro_upload_imagem_carta" });
      }

      if (!req.file) {
        return res.status(400).json({ ok: false, error: "Imagem obrigatória" });
      }

      const cartaId = String(req.params.id || "").trim();
      const cartas = readCartasApp();
      const idx = cartas.findIndex(carta => String(carta?.id || "") === cartaId);

      if (idx === -1) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(404).json({ ok: false, error: "Carta não encontrada" });
      }

      const imagemAntiga = String(cartas[idx].imagem_path || "").trim();
      if (imagemAntiga) {
        const base = path.resolve(DATA_DIR);
        const antigaPath = path.resolve(DATA_DIR, imagemAntiga);
        const novaPath = path.resolve(req.file.path);

        if (antigaPath !== novaPath && antigaPath.startsWith(base + path.sep)) {
          try { fs.unlinkSync(antigaPath); } catch {}
        }
      }

      cartas[idx].imagem_url = "";
      cartas[idx].imagem_path = path.relative(DATA_DIR, req.file.path).replace(/\\/g, "/");
      cartas[idx].imagem_atualizada_em = new Date().toISOString();

      writeCartasApp(cartas);

      return res.json({
        ok: true,
        carta: cartas[idx],
        imagem_url_cliente: `/cartas-app/${encodeURIComponent(cartaId)}/imagem`
      });
    } catch {
      return res.status(500).json({ ok: false, error: "erro_salvar_imagem_carta" });
    }
  });
});

app.get("/cartas-app/:id/imagem", auth, (req, res) => {
  try {
    const carta = getCartaAppAtivaById(req.params.id);
    const imagemPath = String(carta?.imagem_path || "").trim();

    if (!carta || !imagemPath) {
      return res.status(404).json({ ok: false, error: "Imagem não encontrada" });
    }

    const base = path.resolve(DATA_DIR);
    const alvo = path.resolve(DATA_DIR, imagemPath);

    if (!alvo.startsWith(base + path.sep) || !fs.existsSync(alvo)) {
      return res.status(404).json({ ok: false, error: "Imagem não encontrada" });
    }

    res.setHeader("Cache-Control", "public, max-age=300");
    return res.sendFile(alvo);
  } catch {
    return res.status(500).json({ ok: false, error: "erro_imagem_carta" });
  }
});

// ===== MERCADO PAGO =====
app.post("/comprar-creditos", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN não configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube - R$8", valor_pago: 8.00, credito: 8.00 },
      saldo_1800: { titulo: "Saldo IA4Tube - R$18", valor_pago: 18.00, credito: 18.00 },
      saldo_2800: { titulo: "Saldo IA4Tube - R$28", valor_pago: 28.00, credito: 28.00 },
      saldo_4800: { titulo: "Saldo IA4Tube - R$48", valor_pago: 48.00, credito: 48.00 }
    };

    const p = pacotes[pacote];

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote inválido" });
    }

    const preference = {
      items: [{
        title: p.titulo,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(p.valor_pago)
      }],
      external_reference: `${whatsapp}|${pacote}|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp,
        pacote,
        credito: Number(p.credito)
      },
      back_urls: {
        success: "https://omascote.com.br/app.html",
        failure: "https://omascote.com.br/app.html",
        pending: "https://omascote.com.br/app.html"
      },
      notification_url: "https://api.omascote.com.br/webhook/mercadopago",
      auto_return: "approved"
    };

    const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(preference)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao criar checkout", detalhe: data });
    }

    return res.json({
      ok: true,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao criar compra" });
  }
});

app.post("/comprar-creditos-pix", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN nÃ£o configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube - R$8", valor_pago: 8.00, credito: 8.00 },
      saldo_1800: { titulo: "Saldo IA4Tube - R$18", valor_pago: 18.00, credito: 18.00 },
      saldo_2800: { titulo: "Saldo IA4Tube - R$28", valor_pago: 28.00, credito: 28.00 },
      saldo_4800: { titulo: "Saldo IA4Tube - R$48", valor_pago: 48.00, credito: 48.00 }
    };

    const p = pacotes[pacote];

    if (!p) {
      return res.status(400).json({ ok: false, error: "Pacote invÃ¡lido" });
    }

    const payerEmail = `${String(whatsapp).replace(/\D/g, "") || "cliente"}@ia4tube.com.br`;
    const paymentPayload = {
      transaction_amount: Number(Number(p.valor_pago).toFixed(2)),
      description: p.titulo,
      payment_method_id: "pix",
      payer: {
        email: payerEmail
      },
      external_reference: `saldo_pix|${whatsapp}|${pacote}|${Date.now()}`,
      metadata: {
        tipo: "saldo",
        whatsapp,
        pacote,
        credito: Number(p.credito)
      },
      notification_url: "https://api.omascote.com.br/webhook/mercadopago"
    };

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `saldo_pix_${whatsapp}_${pacote}_${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar Pix", detalhe: data });
    }

    const transactionData = data.point_of_interaction?.transaction_data || {};

    return res.json({
      ok: true,
      pix_copia_cola: transactionData.qr_code || "",
      qr_code_base64: transactionData.qr_code_base64 || "",
      ticket_url: transactionData.ticket_url || "",
      payment_id: data.id,
      valor_pago: Number(p.valor_pago),
      credito: Number(p.credito)
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar Pix" });
  }
});

app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id || req.query?.id;

    if (!paymentId) {
      return res.json({ ok: true });
    }

    let processados = readMpProcessados();

    if (processados[paymentId]) {
      return res.json({ ok: true, duplicado: true });
    }

    processados[paymentId] = {
      status: "processando",
      criado_em: new Date().toISOString()
    };

    writeMpProcessados(processados);

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    const pagamento = await r.json();

    if (!r.ok || pagamento.status !== "approved") {
      processados = readMpProcessados();
      delete processados[paymentId];
      writeMpProcessados(processados);

      return res.json({ ok: true, status: pagamento.status || "ignorado" });
    }

    const external = String(pagamento.external_reference || "");
    const tipo = pagamento.metadata?.tipo || "";

    if (tipo === "pedido_pix") {
      const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[1];
      const pedidoId = pagamento.metadata?.pedido_id || external.split("|")[2];

      if (!whatsapp || !pedidoId) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          status: "erro_sem_pedido",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const base = getPedidoBase(whatsapp, pedidoId);

      if (!base) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "pedido_nao_encontrado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const pedidoPath = path.join(base, "pedido.json");
      const pedido = safeReadJson(pedidoPath) || {};

      if (pedido.pagamento_pendente !== true) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "ja_liberado",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      if (String(pedido.mp_payment_id || "") !== String(paymentId)) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "payment_id_divergente",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const confirmadoEm = new Date().toISOString();
      const documentoNumero = String(pagamento.payer?.identification?.number || "").replace(/\D/g, "");
      const documentoFinal = documentoNumero ? documentoNumero.slice(-4) : "";

      pedido.pagamento_pendente = false;
      pedido.pagamento_metodo = "pix";
      pedido.pagamento_confirmado_em = confirmadoEm;
      pedido.mp_payment_status = "approved";
      pedido.pagamento_info = {
        tipo: "pedido_pix",
        status: pagamento.status || "",
        valor_pago: Number(pagamento.transaction_amount || 0),
        payment_id: String(paymentId),
        whatsapp: whatsapp,
        pedido_id: pedidoId,
        confirmado_em: confirmadoEm,
        pagador: {
          email: pagamento.payer?.email || "",
          nome: pagamento.payer?.first_name || "",
          sobrenome: pagamento.payer?.last_name || "",
          documento_tipo: pagamento.payer?.identification?.type || "",
          documento_final: documentoFinal
        }
      };

      pedido.mensagens_cliente = Array.isArray(pedido.mensagens_cliente)
        ? pedido.mensagens_cliente
        : [];

      const jaTemMensagemPagamento = pedido.mensagens_cliente.some(msg =>
        msg &&
        msg.tipo === "pagamento_confirmado" &&
        String(msg.payment_id || "") === String(paymentId)
      );

      if (!jaTemMensagemPagamento) {
        pedido.mensagens_cliente.push({
          id: "msg_pagamento_" + Date.now(),
          tipo: "pagamento_confirmado",
          titulo: "Pagamento confirmado ✅",
          texto: "Seu pagamento foi aprovado. Sua arte já está liberada ou será liberada assim que ficar pronta.",
          lida: false,
          payment_id: String(paymentId),
          criado_em: confirmadoEm
        });
      }

      const valorBonusPedido = calcularBonusPrimeiraCompraSeguro(pedido, pagamento);

      if (valorBonusPedido > 0) {
        const clientes = readClientes();
        const c = clientes[whatsapp];

        if (c && c.primeira_compra_bonus_concedido !== true) {
          c.saldo_extra = Number(c.saldo_extra || 0) + valorBonusPedido;
          c.primeira_compra_bonus_concedido = true;
          c.primeira_compra_bonus_valor = valorBonusPedido;
          c.primeira_compra_bonus_em = confirmadoEm;
          clientes[whatsapp] = c;
          writeClientes(clientes);
          pedido.bonus_primeira_compra = true;
          pedido.bonus_saldo_extra = valorBonusPedido;
          pedido.bonus_saldo_extra_em = confirmadoEm;
        }
      }

      registrarUsoCupomPedido(pedido, whatsapp);
      fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: pedidoId,
        status: pagamento.status,
        criado_em: new Date().toISOString()
      };
      writeMpProcessados(processados);

      return res.json({ ok: true });
    }

    const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[0];
    const validacaoCredito = validarCreditoSaldoMercadoPago(pagamento.metadata?.credito);
    const credito = validacaoCredito.credito;

    if (!whatsapp || !credito) {
      return res.json({ ok: true, error: "sem whatsapp ou credito" });
    }

    if (!validacaoCredito.ok || validacaoCredito.acimaDoLimite) {
      console.warn("[MP_WEBHOOK] credito_saldo_rejeitado", {
        payment_id: String(paymentId),
        whatsapp,
        credito_metadata: pagamento.metadata?.credito,
        credito_normalizado: credito,
        transaction_amount: pagamento.transaction_amount,
        motivo: validacaoCredito.acimaDoLimite ? "credito_acima_60" : "credito_fora_dos_pacotes"
      });

      processados = readMpProcessados();
      processados[paymentId] = {
        whatsapp,
        credito,
        status: "credito_saldo_rejeitado",
        motivo: validacaoCredito.acimaDoLimite ? "credito_acima_60" : "credito_fora_dos_pacotes",
        criado_em: new Date().toISOString()
      };

      writeMpProcessados(processados);
      return res.json({ ok: true, rejeitado: true });
    }

    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      return res.json({ ok: true, error: "cliente não encontrado" });
    }

    c.saldo_extra = Number(c.saldo_extra || 0) + credito;
    c.ativo = true;

    if (c.brinde_mascote_ja_liberado !== true) {
      c.brinde_mascote_disponivel = true;
      c.brinde_mascote_ja_liberado = true;
      c.brinde_mascote_liberado_em = new Date().toISOString();
    }

    clientes[whatsapp] = c;
    writeClientes(clientes);

    processados[paymentId] = {
      whatsapp,
      credito,
      status: pagamento.status,
      criado_em: new Date().toISOString()
    };

    writeMpProcessados(processados);

    return res.json({ ok: true });

  } catch (e) {
    return res.json({ ok: true });
  }
});

// ===== CRIA PEDIDO =====
function criarPedidoHandler(categoria) {
  return (req, res) => {
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c || !c.ativo) {
      return res.status(403).json({ ok: false, error: "Mensalidade inativa" });
    }

    const jsonValidation = orderService.validateOrderJsonBody(req.body || {}, categoria);
    if (!jsonValidation.ok) {
      limparUploadsTemporarios(req.files);
      return res.status(400).json({
        ok: false,
        error: "JSON invalido no pedido.",
        detalhes: jsonValidation.errors
      });
    }

    const mesAtual = nowYYYYMM();
    billingService.ensureCurrentBillingCycle(c, mesAtual);

    const temBrindeMascote = billingService.hasMascoteUniformeGift(categoria, c);
    const brindeEscudo3dApp = clienteElegivelBrindeEscudo3dApp(req, c, whatsapp, categoria);

    const custoPedido = getCustoPedido(categoria, c);
    const valorBaseParaCupom = brindeEscudo3dApp ? 0 : custoPedido;
    const cupomCodigo = normalizarCupomCodigo(req.body?.cupom_codigo);
    let cupomLockAtivo = false;
    let cuponsJogadorEscudo = null;
    let cupomLegacyJogadorEscudo = false;
    let resultadoCupom = validarCupomPedido({
      codigo: cupomCodigo,
      categoria,
      valorOriginal: valorBaseParaCupom,
      whatsapp
    });

    if (!resultadoCupom.ok && cupomCodigo && categoria === "jogador_escudo" && String(resultadoCupom.error || "").toLowerCase().includes("encontrado")) {
      if (categoria !== "jogador_escudo") {
        return res.status(400).json({ ok: false, error: "Cupom válido apenas para Jogador + Escudo." });
      }

      cupomLockAtivo = adquirirLockCupomJogadorEscudo();

      if (!cupomLockAtivo) {
        return res.status(409).json({ ok: false, error: "Cupom em validação. Tente novamente em alguns segundos." });
      }

      cuponsJogadorEscudo = readCuponsJogadorEscudo();
      const cupom = cuponsJogadorEscudo[cupomCodigo];

      if (!cupom) {
        liberarLockCupomJogadorEscudo();
        cupomLockAtivo = false;
        return res.status(400).json({ ok: false, error: "Cupom não encontrado." });
      }

      if (cupom.ativo === false || cupom.usado === true) {
        liberarLockCupomJogadorEscudo();
        cupomLockAtivo = false;
        return res.status(400).json({ ok: false, error: "Cupom já usado ou inativo." });
      }

      cupomLegacyJogadorEscudo = true;
      resultadoCupom = {
        ok: true,
        cupomAplicado: true,
        cupomCodigo,
        valorOriginal: Number(Number(valorBaseParaCupom || 0).toFixed(2)),
        desconto: Number(Number(valorBaseParaCupom || 0).toFixed(2)),
        valorFinal: 0,
        resumo: {
          codigo: String(cupomCodigo || "").toUpperCase(),
          tipo: "valor",
          valor_original: Number(Number(valorBaseParaCupom || 0).toFixed(2)),
          desconto: Number(Number(valorBaseParaCupom || 0).toFixed(2)),
          valor_final: 0
        }
      };
    }

    if (!resultadoCupom.ok) {
      return res.status(resultadoCupom.status || 400).json({
        ok: false,
        error: resultadoCupom.error || "Cupom invÃ¡lido."
      });
    }

    const cupomAplicado = resultadoCupom.cupomAplicado === true;
    let custoEfetivoPedido = brindeEscudo3dApp ? 0 : resultadoCupom.valorFinal;
    const temSaldoSuficiente = billingService.hasEnoughBalance(c, custoEfetivoPedido);

    const fields = orderService.normalizeOrderBody(req.body);
    const previewLimiterIdentifiers = getPreviewLimiterIdentifiers(req, c, whatsapp);
    const previewLimiterState = getPreviewLimiterState(previewLimiterIdentifiers);

    if (!temSaldoSuficiente && previewLimiterState.total >= PREVIEW_LIMITER_MAX) {
      console.warn(`[PREVIEW_LIMIT] bloqueado identificador=${previewLimiterState.identificador} total=${previewLimiterState.total} motivo=3_previews_sem_pagamento`);

      return res.status(429).json({
        ok: false,
        erro: "limite_preview",
        mensagem: "Detectamos várias prévias geradas em sequência. Aguarde um pouco para criar novas artes."
      });
    }

    if (!orderService.hasRequiredOrderFields(fields)) {
      return res.status(400).json({
        ok: false,
        error: "rodada e data são obrigatórios"
      });
    }

    const files = req.files || {};
    let draft;

    try {
      draft = orderService.createOrderDraft({
        categoria,
        pedidosDir: PEDIDOS_DIR,
        whatsapp,
        mesAtual,
        fields,
        files
      });
    } catch (e) {
      console.error("[pedido] erro ao criar pedido", {
        categoria,
        whatsapp,
        erro: e.message,
        code: e.code
      });

      return res.status(400).json({
        ok: false,
        error: e.message || "Erro ao salvar arquivos do pedido"
      });
    } finally {
      if (!draft && cupomLockAtivo) {
        liberarLockCupomJogadorEscudo();
        cupomLockAtivo = false;
      }
    }

    const id = draft.id;
    registrarAuditoriaProdutoPedido({ categoria, fields, files, pedidoId: id });

    if (temSaldoSuficiente) {
      billingService.applyOrderCharge(c, { custoPedido: custoEfetivoPedido, mesAtual, temBrindeMascote });

      if (cupomAplicado && custoEfetivoPedido <= 0) {
        const confirmadoEm = new Date().toISOString();

        draft.pedido.cupom_aplicado = true;
        draft.pedido.cupom_codigo = resultadoCupom.resumo.codigo;
        draft.pedido.cupom_tipo = resultadoCupom.resumo.tipo;
        draft.pedido.pagamento_pendente = false;
        draft.pedido.pagamento_metodo = "cupom";
        draft.pedido.pagamento_confirmado_em = confirmadoEm;
        draft.pedido.pagamento_info = {
          tipo: "cupom",
          status: "approved",
          valor_pago: 0,
          desconto: resultadoCupom.desconto,
          payment_id: "",
          whatsapp: whatsapp,
          pedido_id: id,
          confirmado_em: confirmadoEm
        };
        aplicarResumoCupomNoPedido(draft.pedido, resultadoCupom);
        registrarUsoCupomPedido(draft.pedido, whatsapp);

        if (cupomLegacyJogadorEscudo && cuponsJogadorEscudo) {
          cuponsJogadorEscudo[cupomCodigo] = {
            ...(cuponsJogadorEscudo[cupomCodigo] || {}),
            ativo: cuponsJogadorEscudo[cupomCodigo]?.ativo !== false,
            usado: true,
            usado_por: whatsapp,
            pedido_id: id,
            usado_em: confirmadoEm
          };
          writeCuponsJogadorEscudo(cuponsJogadorEscudo);
        }

        orderService.orderStorage.writeOrder(draft.base, draft.pedido);
      } else if (brindeEscudo3dApp) {
        const confirmadoEm = new Date().toISOString();

        c.brinde_escudo3d_app_usado = true;
        c.brinde_escudo3d_app_usado_em = confirmadoEm;
        c.brinde_escudo3d_app_pedido_id = id;
        c.primeiro_pedido_gratis_tipo = "escudo3d";

        draft.pedido.pagamento_pendente = false;
        draft.pedido.pagamento_metodo = "brinde_app";
        draft.pedido.pagamento_confirmado_em = confirmadoEm;
        draft.pedido.brinde_escudo3d_app = true;
        draft.pedido.qualidade_geracao = "low";
        draft.pedido.pagamento_info = {
          tipo: "brinde_app",
          status: "approved",
          valor_pago: 0,
          payment_id: "",
          whatsapp: whatsapp,
          pedido_id: id,
          confirmado_em: confirmadoEm,
          origem: "escudo3d_primeiro_uso_app"
        };

        orderService.orderStorage.writeOrder(draft.base, draft.pedido);
      } else if (custoEfetivoPedido > 0) {
        const confirmadoEm = new Date().toISOString();

        draft.pedido.pagamento_pendente = false;
        draft.pedido.pagamento_metodo = "saldo_ia4tube";
        draft.pedido.pagamento_confirmado_em = confirmadoEm;
        draft.pedido.pagamento_info = {
          tipo: "saldo_ia4tube",
          status: "approved",
          valor_pago: custoEfetivoPedido,
          payment_id: "",
          whatsapp: whatsapp,
          pedido_id: id,
          confirmado_em: confirmadoEm,
          origem: "desconto_automatico_criacao"
        };
        aplicarResumoCupomNoPedido(draft.pedido, resultadoCupom);
        registrarUsoCupomPedido(draft.pedido, whatsapp);

        draft.pedido.mensagens_cliente = Array.isArray(draft.pedido.mensagens_cliente)
          ? draft.pedido.mensagens_cliente
          : [];

        const jaTemMensagemPagamento = draft.pedido.mensagens_cliente.some(msg =>
          msg &&
          msg.tipo === "pagamento_confirmado" &&
          draft.pedido.pagamento_info?.origem === "desconto_automatico_criacao"
        );

        if (!jaTemMensagemPagamento) {
          draft.pedido.mensagens_cliente.push({
            id: "msg_pagamento_" + Date.now(),
            tipo: "pagamento_confirmado",
            titulo: "Pagamento confirmado ✅",
            texto: "Seu saldo IA4Tube foi usado automaticamente para criar esta arte.",
            lida: false,
            criado_em: confirmadoEm
          });
        }

        orderService.orderStorage.writeOrder(draft.base, draft.pedido);
      }
    } else {
      draft.pedido.pagamento_pendente = true;
      draft.pedido.valor_pendente = custoEfetivoPedido;
      draft.pedido.motivo_pagamento_pendente = "saldo_insuficiente";
      aplicarResumoCupomNoPedido(draft.pedido, resultadoCupom);
      orderService.orderStorage.writeOrder(draft.base, draft.pedido);
      registrarPreviewPendente({ identifiers: previewLimiterIdentifiers, whatsapp, pedidoId: id });
    }

    clientes[whatsapp] = c;
    writeClientes(clientes);

    if (cupomLockAtivo) {
      liberarLockCupomJogadorEscudo();
      cupomLockAtivo = false;
    }

    removeOldPedidos(whatsapp, 15);

    return res.json({
      ok: true,
      pedido_id: id,
      pagamento_pendente: draft.pedido.pagamento_pendente === true,
      valor_pendente: Number(draft.pedido.valor_pendente || 0),
      cupom_aplicado: cupomAplicado,
      desconto: cupomAplicado ? resultadoCupom.resumo : null,
      valor_original: cupomAplicado ? resultadoCupom.valorOriginal : Number(custoPedido || 0),
      valor_desconto: cupomAplicado ? resultadoCupom.desconto : 0,
      valor_final: cupomAplicado ? resultadoCupom.valorFinal : Number(custoEfetivoPedido || 0),
      mensagem: cupomAplicado
        ? `Cupom ${resultadoCupom.resumo.codigo} aplicado. Valor final: R$ ${resultadoCupom.valorFinal.toFixed(2).replace(".", ",")}.`
        : undefined
    });
  };
}

// ===== CRIAR PEDIDO =====
app.post("/cupons/preco", (req, res) => {
  try {
    let whatsapp = "";
    let cliente = null;
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";

    if (token) {
      try {
        const user = jwt.verify(token, JWT_SECRET);
        whatsapp = user?.whatsapp || "";
        cliente = whatsapp ? readClientes()[whatsapp] || null : null;
      } catch {}
    }

    const body = req.body || {};
    const product =
      productsRegistry.getProductByAlias(body.product_id || body.categoria) ||
      productsRegistry.getProductByFlyerTipo(body.flyer_tipo);
    const categoria = product?.id || String(body.categoria || body.product_id || "").trim().toLowerCase();

    if (!categoria) {
      return res.status(400).json({ ok: false, error: "Produto invalido." });
    }

    const brindeEscudo3dApp = cliente
      ? clienteElegivelBrindeEscudo3dApp({ ...req, body }, cliente, whatsapp, categoria)
      : false;
    const custoPedido = getCustoPedido(categoria, cliente);
    const valorOriginal = brindeEscudo3dApp ? 0 : custoPedido;
    const cupomCodigo = normalizarCupomCodigo(body.cupom_codigo);
    let resultadoCupom = validarCupomPedido({
      codigo: cupomCodigo,
      categoria,
      valorOriginal,
      whatsapp
    });

    if (!resultadoCupom.ok && cupomCodigo && categoria === "jogador_escudo" && String(resultadoCupom.error || "").toLowerCase().includes("encontrado")) {
      const cupomLegacy = readCuponsJogadorEscudo()[cupomCodigo];

      if (cupomLegacy && cupomLegacy.ativo !== false && cupomLegacy.usado !== true) {
        const original = Number(Number(valorOriginal || 0).toFixed(2));
        resultadoCupom = {
          ok: true,
          cupomAplicado: true,
          cupomCodigo,
          valorOriginal: original,
          desconto: original,
          valorFinal: 0,
          resumo: {
            codigo: String(cupomCodigo || "").toUpperCase(),
            tipo: "valor",
            valor: original,
            valor_original: original,
            desconto: original,
            valor_final: 0
          }
        };
      }
    }

    if (!resultadoCupom.ok) {
      return res.status(resultadoCupom.status || 400).json({
        ok: false,
        error: resultadoCupom.error || "Cupom invalido.",
        cupom_aplicado: false,
        valor_original: Number(valorOriginal || 0),
        valor_desconto: 0,
        valor_final: Number(valorOriginal || 0)
      });
    }

    return res.json({
      ok: true,
      produto: categoria,
      cupom_aplicado: resultadoCupom.cupomAplicado === true,
      desconto: resultadoCupom.cupomAplicado ? resultadoCupom.resumo : null,
      valor_original: resultadoCupom.cupomAplicado ? resultadoCupom.valorOriginal : Number(valorOriginal || 0),
      valor_desconto: resultadoCupom.cupomAplicado ? resultadoCupom.desconto : 0,
      valor_final: resultadoCupom.cupomAplicado ? resultadoCupom.valorFinal : Number(valorOriginal || 0)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao calcular cupom." });
  }
});

app.post(
  "/pedidos",
  auth,
  uploadComErroControlado(upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 4 },
    { name: "patrocinadores", maxCount: 20 }
  ])),
  (req, res) => {
    const flyer_tipo = (req.body?.flyer_tipo || "").toLowerCase();
    const productFromRegistry = productsRegistry.getProductByFlyerTipo(flyer_tipo);

    if (productFromRegistry) return criarPedidoHandler(productFromRegistry.id)(req, res);

    if (flyer_tipo === "escudo3d") return criarPedidoHandler("escudo3d")(req, res);
    if (flyer_tipo === "zz1fs") return criarPedidoHandler("escalacao")(req, res);
    if (flyer_tipo === "zz1fm") return criarPedidoHandler("contratacao")(req, res);
    if (flyer_tipo === "zz1ft") return criarPedidoHandler("proximo_jogo")(req, res);
    if (flyer_tipo === "zz1fj") return criarPedidoHandler("patrocinador")(req, res);
    if (flyer_tipo === "jog_proximo") return criarPedidoHandler("proximo_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_resultado") return criarPedidoHandler("resultado_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_escudo") return criarPedidoHandler("jogador_escudo")(req, res);
    if (flyer_tipo === "mascote_uniforme") return criarPedidoHandler("mascote_uniforme")(req, res);

    limparUploadsTemporarios(req.files);
    console.warn("[pedido] flyer_tipo desconhecido bloqueado", {
      flyer_tipo,
      product_id: req.body?.product_id || "",
      categoria: req.body?.categoria || ""
    });

    return res.status(400).json({
      ok: false,
      error: "Produto invalido."
    });
  }
);

app.post(
  "/mascotes",
  auth,
  uploadComErroControlado(upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 }
  ])),
  criarPedidoHandler("mascote")
);

app.post(
  "/resultado_do_jogo",
  auth,
  uploadComErroControlado(upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 4 },
    { name: "patrocinadores", maxCount: 20 }
  ])),
  criarPedidoHandler("resultado")
);

// ===== BOT ADMIN: LISTAR NOVOS DE TODOS OS CLIENTES =====
app.get("/bot/pedidos/novos", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const pedidos = [];

  if (!fs.existsSync(PEDIDOS_DIR)) {
    return res.json({ ok: true, pedidos: [] });
  }

  const whatsapps = fs.readdirSync(PEDIDOS_DIR);

  for (const whatsapp of whatsapps) {
    const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);
    if (!fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) continue;

    const meses = fs.readdirSync(pastaWhatsapp);

    for (const mes of meses) {
      const pastaMes = path.join(pastaWhatsapp, mes);
      if (!fs.existsSync(pastaMes) || !fs.statSync(pastaMes).isDirectory()) continue;

      const ids = fs.readdirSync(pastaMes);

      for (const id of ids) {
        const base = path.join(pastaMes, id);
        const statusPedido = readOrderStatus(base, "");

        if (statusPedido === "novo" || statusPedido === "ajuste_pendente") {
          pedidos.push({ id, whatsapp, mes, status: statusPedido });
        }
      }
    }
  }

  return res.json({ ok: true, pedidos });
});

app.get("/bot/pedidos/:id/zip", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", err => res.status(500).end(String(err)));

  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

app.post("/bot/pedidos/:id/status", auth, (req, res) => {
  if (!isBotAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Acesso negado" });
  }

  const base = getPedidoBaseGlobal(req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const { status } = req.body || {};

  if (!orderStatus.isValidPublicStatus(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  writeOrderStatus(base, status);

  return res.json({ ok: true });
});

// ===== LISTAR NOVOS =====
app.get("/pedidos/novos", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const mesAtual = nowYYYYMM();
  const dir = path.join(PEDIDOS_DIR, whatsapp, mesAtual);

  if (!fs.existsSync(dir)) {
    return res.json({ ok: true, pedidos: [] });
  }

  const pedidos = [];

  for (const id of fs.readdirSync(dir)) {
    const pdir = path.join(dir, id);

    if (readOrderStatus(pdir, "") === "novo") {
      pedidos.push({ id });
    }
  }

  return res.json({ ok: true, pedidos });
});

app.get("/meus-pedidos", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "meus_pedidos" });

  const whatsapp = req.user.whatsapp;
  const itens = listPedidoBasesByWhatsapp(whatsapp).slice(0, 15);

  const pedidos = itens.map((item) => {
    const resultadoFinalPath = path.join(item.base, "resultado_final.png");
    const status = readOrderStatus(item.base, item.pedido.status || "novo");
    const imagemPronta = fs.existsSync(resultadoFinalPath);
    const aprovadoCliente = item.pedido.aprovado_cliente === true;
    const pagamentoPendente = item.pedido.pagamento_pendente === true;
    const ajusteUsado = item.pedido.ajuste_automatico_usado === true;

    return {
      id: item.id,
      tipo: nomeCategoriaPedido(item.pedido.categoria || ""),
      status,
      data: item.pedido.data || item.criado_em,
      criado_em: item.criado_em,
      imagem_url: imagemPronta
        ? `${req.protocol}://${req.get("host")}/pedidos/${item.id}/preview`
        : null,
      imagem_pronta: imagemPronta,
      descricao_instagram: item.pedido.descricao_instagram || "",
      aprovado_cliente: aprovadoCliente,
      pagamento_pendente: pagamentoPendente,
      valor_pendente: Number(item.pedido.valor_pendente || 0),
      valor_original: Number(item.pedido.valor_original || 0),
      valor_desconto: Number(item.pedido.valor_desconto || 0),
      valor_final: Number(item.pedido.valor_final || item.pedido.valor_pendente || 0),
      desconto_info: item.pedido.desconto_info || null,
      motivo_pagamento_pendente: item.pedido.motivo_pagamento_pendente || "",
      ajuste_automatico_usado: ajusteUsado,
      motivo_ajuste: item.pedido.motivo_ajuste || "",
      pode_baixar: imagemPronta && aprovadoCliente && !pagamentoPendente,
      pode_pedir_ajuste: imagemPronta && !aprovadoCliente && !ajusteUsado && status === "pronto"
    };
  });

  return res.json({ ok: true, pedidos });
});

app.post("/pedidos/:id/pagar-com-saldo", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (pedido.pagamento_pendente !== true) {
    return res.json({
      ok: true,
      mensagem: "Pedido ja liberado.",
      pagamento_pendente: false
    });
  }

  const valorPendente = Number(pedido.valor_pendente || 0);

  if (!valorPendente || valorPendente <= 0) {
    return res.status(400).json({ ok: false, error: "Valor pendente invalido." });
  }

  const clientes = readClientes();
  const c = clientes[whatsapp];

  if (!c) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const mesAtual = nowYYYYMM();
  billingService.ensureCurrentBillingCycle(c, mesAtual);

  if (!billingService.hasEnoughBalance(c, valorPendente)) {
    clientes[whatsapp] = c;
    writeClientes(clientes);
    return res.status(403).json({
      ok: false,
      error: "Saldo insuficiente para desbloquear esta imagem."
    });
  }

  billingService.applyOrderCharge(c, {
    custoPedido: valorPendente,
    mesAtual,
    temBrindeMascote: false
  });

  const confirmadoEm = new Date().toISOString();

  pedido.pagamento_pendente = false;
  pedido.pagamento_metodo = "saldo_ia4tube";
  pedido.pagamento_confirmado_em = confirmadoEm;
  pedido.pagamento_info = {
    tipo: "saldo_ia4tube",
    status: "approved",
    valor_pago: valorPendente,
    payment_id: "",
    whatsapp: whatsapp,
    pedido_id: req.params.id,
    confirmado_em: confirmadoEm
  };
  registrarUsoCupomPedido(pedido, whatsapp);
  pedido.mensagens_cliente = Array.isArray(pedido.mensagens_cliente)
    ? pedido.mensagens_cliente
    : [];
  pedido.mensagens_cliente.push({
    id: "msg_pagamento_" + Date.now(),
    tipo: "pagamento_confirmado",
    titulo: "Pagamento confirmado ✅",
    texto: "Seu saldo IA4Tube foi usado e sua arte foi liberada para download.",
    lida: false,
    criado_em: confirmadoEm
  });

  clientes[whatsapp] = c;
  writeClientes(clientes);
  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  return res.json({
    ok: true,
    pagamento_pendente: false
  });
});

app.post("/pedidos/:id/gerar-pix", auth, async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN nao configurado" });
    }

    const whatsapp = req.user.whatsapp;
    const id = req.params.id;
    const base = getPedidoBase(whatsapp, id);

    if (!base) {
      return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
    }

    const pedidoPath = path.join(base, "pedido.json");
    const pedido = safeReadJson(pedidoPath) || {};

    if (pedido.pagamento_pendente !== true) {
      return res.status(400).json({ ok: false, error: "Pedido ja liberado." });
    }

    const valorPendente = Number(pedido.valor_pendente || 0);

    if (!valorPendente || valorPendente <= 0) {
      return res.status(400).json({ ok: false, error: "Valor pendente invalido." });
    }

    if (
      pedido.mp_payment_id &&
      pedido.pix_copia_cola &&
      String(pedido.mp_payment_status || "").toLowerCase() === "pending"
    ) {
      return res.json({
        ok: true,
        pix_copia_cola: pedido.pix_copia_cola,
        qr_code_base64: pedido.pix_qr_code_base64 || "",
        ticket_url: pedido.pix_ticket_url || "",
        payment_id: pedido.mp_payment_id,
        valor_pendente: Number(pedido.valor_pendente || 0),
        valor_original: Number(pedido.valor_original || 0),
        valor_desconto: Number(pedido.valor_desconto || 0),
        valor_final: Number(pedido.valor_final || pedido.valor_pendente || 0),
        desconto_info: pedido.desconto_info || null
      });
    }

    const payerEmail = `${String(whatsapp).replace(/\D/g, "") || "cliente"}@ia4tube.com.br`;
    const paymentPayload = {
      transaction_amount: Number(valorPendente.toFixed(2)),
      description: `IA4Tube - Desbloqueio pedido ${id}`,
      payment_method_id: "pix",
      payer: {
        email: payerEmail
      },
      external_reference: `pedido_pix|${whatsapp}|${id}|${Date.now()}`,
      metadata: {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: id,
        valor_pendente: Number(valorPendente.toFixed(2))
      },
      notification_url: "https://api.omascote.com.br/webhook/mercadopago"
    };

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `pedido_pix_${id}_${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Erro ao gerar Pix", detalhe: data });
    }

    const transactionData = data.point_of_interaction?.transaction_data || {};
    const pixCopiaCola = transactionData.qr_code || "";
    const qrCodeBase64 = transactionData.qr_code_base64 || "";
    const ticketUrl = transactionData.ticket_url || "";

    if (!pixCopiaCola) {
      return res.status(500).json({ ok: false, error: "Mercado Pago nao retornou codigo Pix", detalhe: data });
    }

    pedido.pagamento_metodo_pendente = "pix";
    pedido.mp_payment_id = String(data.id || "");
    pedido.mp_payment_status = data.status || "pending";
    pedido.pix_copia_cola = pixCopiaCola;
    pedido.pix_qr_code_base64 = qrCodeBase64;
    pedido.pix_ticket_url = ticketUrl;
    pedido.pix_gerado_em = new Date().toISOString();

    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

    return res.json({
      ok: true,
      pix_copia_cola: pixCopiaCola,
      qr_code_base64: qrCodeBase64,
      ticket_url: ticketUrl,
      payment_id: pedido.mp_payment_id,
      valor_pendente: Number(pedido.valor_pendente || 0),
      valor_original: Number(pedido.valor_original || 0),
      valor_desconto: Number(pedido.valor_desconto || 0),
      valor_final: Number(pedido.valor_final || pedido.valor_pendente || 0),
      desconto_info: pedido.desconto_info || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro interno ao gerar Pix" });
  }
});

app.get("/pedidos/:id/pagamento-info", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  return res.json({
    ok: true,
    pagamento_pendente: pedido.pagamento_pendente === true,
    valor_pendente: Number(pedido.valor_pendente || 0),
    valor_original: Number(pedido.valor_original || 0),
    valor_desconto: Number(pedido.valor_desconto || 0),
    valor_final: Number(pedido.valor_final || pedido.valor_pendente || 0),
    desconto_info: pedido.desconto_info || null,
    mp_payment_status: pedido.mp_payment_status || "",
    pix_copia_cola: pedido.pix_copia_cola || "",
    qr_code_base64: pedido.pix_qr_code_base64 || "",
    ticket_url: pedido.pix_ticket_url || "",
    payment_id: pedido.mp_payment_id || ""
  });
});

app.post("/pedidos/:id/aprovar", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (pedido.pagamento_pendente === true) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento pendente. Desbloqueie esta imagem antes de baixar.",
      pagamento_pendente: true,
      pode_baixar: false,
      valor_pendente: Number(pedido.valor_pendente || 0)
    });
  }

  pedido.aprovado_cliente = true;
  pedido.baixado_cliente = false;
  pedido.aprovado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");

  return res.json({
    ok: true,
    aprovado_cliente: true,
    pode_baixar: true
  });
});

app.post("/pedidos/:id/solicitar-ajuste", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const motivo = String(req.body?.motivo_ajuste || req.body?.motivo || "").trim();

  if (!motivo || motivo.length < 5) {
    return res.status(400).json({ ok: false, error: "Descreva melhor o ajuste." });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (pedido.ajuste_automatico_usado === true) {
    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      `Pedido ${req.params.id}: ${motivo}`,
      "Esse pedido já usou o ajuste automático. Vou encaminhar para o suporte.",
      "sistema"
    );

    conversa.precisa_humano = true;
    conversa.status = "aguardando_suporte";
    conversa.ultima_atualizacao = new Date().toISOString();

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);
    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok: true,
      modo_humano: true,
      conversa_id: conversa.id
    });
  }

  const resultadoAtual = path.join(base, "resultado_final.png");
  const resultadoBackup = path.join(base, "resultado_final_anterior.png");

  try {
    if (fs.existsSync(resultadoAtual)) {
      fs.copyFileSync(resultadoAtual, resultadoBackup);
    }
  } catch {}

  pedido.ajuste_automatico_usado = true;
  pedido.motivo_ajuste = motivo;
  pedido.aprovado_cliente = false;
  pedido.status = "ajuste_pendente";
  pedido.ajuste_solicitado_em = new Date().toISOString();

  fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  writeOrderStatus(base, orderStatus.ORDER_STATUS.AJUSTE_PENDENTE);
  fs.writeFileSync(path.join(base, "ajuste_pendente.txt"), motivo, "utf8");

  return res.json({
    ok: true,
    modo_humano: false,
    status: "ajuste_pendente"
  });
});

app.get("/pedidos/:id/download-resultado", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (pedido.pagamento_pendente === true) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento pendente. Desbloqueie esta imagem para baixar em alta qualidade."
    });
  }

  if (pedido.aprovado_cliente !== true) {
    return res.status(403).json({
      ok: false,
      error: "Aprove a prévia antes de baixar a imagem em alta qualidade."
    });
  }

  const arquivo = path.join(base, "resultado_final.png");

  if (!fs.existsSync(arquivo)) {
    return res.status(404).json({ ok: false, error: "Resultado final não encontrado" });
  }

  pedido.baixado_cliente = true;
  pedido.baixado_em = new Date().toISOString();

  try {
    fs.writeFileSync(pedidoPath, JSON.stringify(pedido, null, 2), "utf8");
  } catch {}

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}_resultado.png"`);

  return res.sendFile(arquivo);
});

// ===== INFO DO PEDIDO =====
app.get("/pedidos/:id/info", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoJsonPath = path.join(base, "pedido.json");
  const resultadoFinalPath = path.join(base, "resultado_final.png");

  let pedido = {};
  if (fs.existsSync(pedidoJsonPath)) {
    try {
      pedido = JSON.parse(fs.readFileSync(pedidoJsonPath, "utf8"));
    } catch {}
  }

  const status = readOrderStatus(base, "novo");

  const imagem_pronta = fs.existsSync(resultadoFinalPath);

  return res.json({
    ok: true,
    id: req.params.id,
    status,
    categoria: pedido.categoria || "",
    imagem_pronta,
    preview_url: imagem_pronta
      ? `${req.protocol}://${req.get("host")}/pedidos/${req.params.id}/preview`
      : null,
    aprovado_cliente: pedido.aprovado_cliente === true,
    pagamento_pendente: pedido.pagamento_pendente === true,
    valor_pendente: Number(pedido.valor_pendente || 0),
    valor_original: Number(pedido.valor_original || 0),
    valor_desconto: Number(pedido.valor_desconto || 0),
    valor_final: Number(pedido.valor_final || pedido.valor_pendente || 0),
    desconto_info: pedido.desconto_info || null,
    motivo_pagamento_pendente: pedido.motivo_pagamento_pendente || "",
    ajuste_automatico_usado: pedido.ajuste_automatico_usado === true,
    motivo_ajuste: pedido.motivo_ajuste || "",
    pode_baixar: imagem_pronta && pedido.aprovado_cliente === true && pedido.pagamento_pendente !== true,
    pode_pedir_ajuste: imagem_pronta && pedido.aprovado_cliente !== true && pedido.ajuste_automatico_usado !== true && status === "pronto"
  });
});

// ===== PREVIEW PROTEGIDA =====
app.get("/pedidos/:id/preview", (req, res) => {
  const pedidoId = req.params.id;

  function procurarPedidoPorId() {
    if (!fs.existsSync(PEDIDOS_DIR)) return null;

    const whatsapps = fs.readdirSync(PEDIDOS_DIR);

    for (const whatsapp of whatsapps) {
      const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);
      if (!fs.statSync(pastaWhatsapp).isDirectory()) continue;

      const meses = fs.readdirSync(pastaWhatsapp);

      for (const mes of meses) {
        const base = path.join(pastaWhatsapp, mes, pedidoId);
        if (fs.existsSync(base)) return base;
      }
    }

    return null;
  }

  const base = procurarPedidoPorId();

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const previewProtegidaPath = path.join(base, "preview_ia4tube.jpg");

  if (!fs.existsSync(previewProtegidaPath)) {
    return res.status(404).json({ ok: false, error: "Imagem ainda não ficou pronta" });
  }

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store");

  return res.sendFile(previewProtegidaPath);
});

// ===== BAIXAR ZIP =====
app.get("/pedidos/:id/zip", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (pedido.pagamento_pendente === true) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento pendente. Desbloqueie esta imagem antes de baixar o ZIP."
    });
  }

  if (pedido.aprovado_cliente !== true) {
    return res.status(403).json({
      ok: false,
      error: "Aprove a previa antes de baixar o ZIP."
    });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", err => res.status(500).end(String(err)));

  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

// ===== ATUALIZAR STATUS =====
app.post("/pedidos/:id/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const { status } = req.body || {};

  if (!orderStatus.isValidPublicStatus(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  writeOrderStatus(base, status);

  return res.json({ ok: true });
});

// ===== UPLOAD DO RESULTADO FINAL =====
app.post(
  "/bot/pedidos/:id/upload-resultado",
  auth,
  uploadComErroControlado(uploadResultado.fields([
    { name: "resultado", maxCount: 1 },
    { name: "preview", maxCount: 1 }
  ])),
  (req, res) => {

    const descricao_instagram = req.body?.descricao_instagram || "";
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const base = getPedidoBaseGlobal(req.params.id);

    if (!base) {
      return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
    }

    const resultadoFile = req.files?.resultado?.[0] || null;
    const previewFile = req.files?.preview?.[0] || null;

    if (!resultadoFile) {
      return res.status(400).json({ ok: false, error: "Arquivo resultado não enviado" });
    }

    const dest = path.join(base, "resultado_final.png");
    const previewDest = path.join(base, "preview_ia4tube.jpg");

    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(resultadoFile.path, dest);

      if (previewFile) {
        if (fs.existsSync(previewDest)) fs.unlinkSync(previewDest);
        fs.renameSync(previewFile.path, previewDest);
      }

      writeOrderStatus(base, orderStatus.ORDER_STATUS.PRONTO);

      try {
        const ajustePendentePath = path.join(base, "ajuste_pendente.txt");
        if (fs.existsSync(ajustePendentePath)) fs.unlinkSync(ajustePendentePath);
      } catch {}

      try {
        const pedidoPath = path.join(base, "pedido.json");
        if (fs.existsSync(pedidoPath)) {
          const pedidoData = JSON.parse(fs.readFileSync(pedidoPath, "utf8"));
          pedidoData.descricao_instagram = descricao_instagram || "";
          pedidoData.status = "pronto";
          pedidoData.aprovado_cliente = false;
          pedidoData.baixado_cliente = false;
          pedidoData.resultado_enviado_em = new Date().toISOString();
          fs.writeFileSync(pedidoPath, JSON.stringify(pedidoData, null, 2), "utf8");
        }
      } catch (e) {}

      return res.json({
        ok: true,
        arquivo: "resultado_final.png",
        preview: previewFile ? "preview_ia4tube.jpg" : ""
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "Falha ao salvar resultado"
      });
    }
  }
);

// ===== SUPORTE CHAT =====
app.post("/suporte/chat", auth, async (req, res) => {
  try {
    const { mensagem } = req.body || {};
    const whatsapp = req.user.whatsapp;

    const abertasHumanas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversaHumana = abertasHumanas.find(c =>
      c.whatsapp === whatsapp &&
      !c.finalizada &&
      (
        c.status === "humano_assumiu" ||
        c.precisa_humano === true
      )
    );

    if (conversaHumana) {
      conversaHumana.mensagens = conversaHumana.mensagens || [];

      conversaHumana.mensagens.push({
        id: `${Date.now()}_cliente`,
        data: new Date().toISOString(),
        autor: "cliente",
        texto: String(mensagem || "").trim()
      });

      conversaHumana.ultima_atualizacao = new Date().toISOString();

      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertasHumanas);

      return res.json({
        ok:true,
        modo_humano:true,
        conversa_id: conversaHumana.id,
        resposta:null
      });
    }

    if (!mensagem || !String(mensagem).trim()) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY não configurada" });
    }

    const msg = String(mensagem || "").toLowerCase();

// ===== RESPOSTAS GRÁTIS (SEM IA) =====
if(msg.includes("resultado do jogo") && msg.includes("entender")){
  return res.json({
    ok:true,
    resposta:`Resultado do jogo mostra placar e escudos.\n\nObrigatório:\n- Times\n- Placar\n- Escudos\n\nOpcional:\n- Frase\n- Artilheiros\n- Foto`
  });
}

if(msg.includes("próximo jogo jogador") || msg.includes("proximo jogo jogador")){
  return res.json({
    ok:true,
    resposta:`Próximo jogo jogador cria uma arte focada em um jogador para divulgar a próxima partida.\n\nObrigatório:\n- Time A e Time B\n- Escudo do time\n- Foto do jogador\n- Data e horário\n- Campeonato/competição\n\nOpcional:\n- Local`
  });
}

if(msg.includes("resultado jogador")){
  return res.json({
    ok:true,
    resposta:`Resultado jogador cria uma arte de resultado com foco no jogador.\n\nObrigatório:\n- Times\n- Placar\n- Escudos\n- Foto do jogador\n\nOpcional:\n- Frase\n- Campeonato/competição`
  });
}

if(msg.includes("jogador + escudo") || msg.includes("jogador e escudo")){
  return res.json({
    ok:true,
    resposta:`Jogador + escudo cria uma arte simples e forte com o jogador e o escudo do time.\n\nObrigatório:\n- Nome do jogador\n- Escudo do time\n- Foto do jogador\n\nOpcional:\n- Nenhum`
  });
}

if(msg.includes("como baixar") || msg.includes("baixar novamente")){
  return res.json({
    ok:true,
    resposta:"Vá em Meus pedidos e clique em Baixar novamente."
  });
}

if(msg.includes("saldo") && msg.includes("como")){
  return res.json({
    ok:true,
    resposta:"Clique em Adicionar saldo no topo da tela."
  });
}

// ===== SUPORTE DIRETO (SEM IA) =====
if(
  msg.includes("erro") ||
  msg.includes("não chegou") ||
  msg.includes("nao chegou") ||
  msg.includes("errado") ||
  msg.includes("alteração") ||
  msg.includes("suporte")
){
  const conversa = salvarMensagemSuporteAberta(whatsapp, mensagem, "Vou encaminhar sua solicitação para o suporte.", "sistema");
  conversa.precisa_humano = true;
  conversa.status = "aguardando_suporte";
  conversa.ultima_atualizacao = new Date().toISOString();

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const idx = abertas.findIndex(c => c.id === conversa.id);
  if(idx >= 0){
    abertas[idx] = conversa;
    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
  }

  return res.json({
    ok:true,
    modo_humano:true,
    conversa_id: conversa.id,
    resposta:"Vou encaminhar sua solicitação para o suporte."
  });
}

// ===== SE NÃO CAIU EM NADA → USA IA =====
const pedidos = listPedidoBasesByWhatsapp(whatsapp).slice(0, 5);

    const resumoPedidos = pedidos.map((p) => {
      const resultadoFinalPath = path.join(p.base, "resultado_final.png");

      const status = readOrderStatus(p.base, p.pedido.status || "novo");

      return {
        id: p.id,
        status,
        categoria: p.pedido.categoria || "",
        rodada: p.pedido.rodada || "",
        data: p.pedido.data || "",
        criado_em: p.criado_em,
        imagem_pronta: fs.existsSync(resultadoFinalPath)
      };
    });

    const prompt = `
Você é o suporte automático da IA4Tube.

REGRAS:
- Responda sempre em português do Brasil.
- Responda curto, simples e direto.
- Não invente status, prazo ou informação.
- Use os pedidos reais abaixo somente quando o cliente perguntar sobre pedido.

MENU DO SUPORTE:
1. Dúvida sobre produto
2. Não consigo enviar pedido
3. Meu pedido deu erro / alteração
4. Pedido pronto / download
5. Pagamento / saldo
6. Quero falar com suporte

COMPORTAMENTO:
- Se for cumprimento, responda: "Oi! Escolha uma opção no menu do suporte."
- Se o cliente pedir opções, disser "quais opções", "me dê as opções" ou algo parecido, responda curto: "Use os botões do menu do suporte."
- Se o cliente falar "dúvida sobre produto" ou perguntar "como funciona", responda: "Escolha o produto no menu abaixo."

- Se o cliente disser "Quero entender Resultado do jogo", explique somente Resultado do jogo.
- Se o cliente disser "Quero entender Escalação", explique somente Escalação.
- Se o cliente disser "Quero entender Contratação", explique somente Contratação.
- Se o cliente disser "Quero entender Próximo jogo", explique somente Próximo jogo.
- Se o cliente disser "Quero entender Patrocinador", explique somente Patrocinador.
- Se o cliente disser "Quero entender Escudo 3D", responda: "Escudo 3D transforma o escudo do time em uma arte 3D moderna. Obrigatório: enviar o escudo do time. Opcional: nenhuma informação extra."
- Se o cliente disser "Quero entender Próximo jogo jogador", explique somente Próximo jogo jogador.
- Se o cliente disser "Quero entender Resultado jogador", explique somente Resultado jogador.
- Se o cliente disser "Quero entender Jogador + escudo", explique somente Jogador + escudo.

- Ao explicar produto, sempre separe "Obrigatório" e "Opcional".
- Se o cliente disser "Não sei o que preencher", pergunte: "Qual produto você está tentando enviar?"
- Se o cliente disser "Não consigo enviar imagem", responda: "Tente enviar uma imagem em PNG ou JPG. Se continuar dando erro, vou encaminhar para o suporte."
- Se o cliente disser "Botão criar minha arte não funciona", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Apareceu erro ao enviar pedido", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Não consigo enviar pedido", pergunte: "Qual produto você está tentando enviar?"

- Se o cliente disser imagem com nome errado, texto errado, escudo errado, imagem estranha, pedir alteração, pedido não chegou, problema técnico ou reclamação, responda exatamente: "Vou encaminhar sua solicitação para o suporte."

- Se o cliente perguntar como baixar, responda: "Vá em Meus pedidos e clique em Baixar novamente."
- Se o cliente disser "Não apareceu meu pedido pronto", responda: "Confira em Meus pedidos. Se ainda não apareceu, aguarde alguns minutos. Se continuar, vou encaminhar para o suporte."
- Se o cliente disser "Quero baixar novamente", responda: "Vá em Meus pedidos e clique em Baixar novamente."
- Se o cliente disser "Meu pedido está demorando", responda: "Aguarde alguns minutos e confira em Meus pedidos. Se continuar demorando, vou encaminhar para o suporte."

- Se o cliente perguntar como adicionar saldo, responda: "Clique em Adicionar saldo no topo da tela e escolha um valor."
- Se o cliente disser "Paguei e meu saldo não apareceu", responda exatamente: "Vou encaminhar sua solicitação para o suporte."
- Se o cliente disser "Saldo insuficiente", responda: "Clique em Adicionar saldo no topo da tela e escolha um valor."
- Se o cliente perguntar valores de saldo, responda: "Você pode adicionar R$8, R$18, R$28 ou R$48."

- Se o cliente pedir suporte humano ou disser "Quero falar com suporte", responda exatamente: "Vou encaminhar sua solicitação para o suporte."

PRODUTOS:

Resultado do jogo:
- Mostra o placar da partida, os escudos dos times e uma frase relacionada ao jogo.
- Obrigatório:
  1. Definir quais times estão jogando.
  2. Definir o placar.
  3. Selecionar os escudos.
- Opcional:
  4. Criar uma frase.
  5. Informar campeonato/competição.
  6. Informar artilheiros.
  7. Enviar foto do jogo ou do time.

Escalação:
- Mostra a lista de jogadores do time.
- Obrigatório:
  1. Título da arte.
  2. Escudo do time.
  3. Nome dos jogadores.
- Opcional:
  4. Posição dos jogadores.
  5. Escudo adversário.
  6. Foto do jogador ou do time.

Contratação:
- Anúncio de jogador contratado, renovado ou apresentado.
- Obrigatório:
  1. Título da arte.
  2. Nome do jogador.
  3. Escudo do time.
  4. Foto do jogador.
- Opcional:
  5. Posição ou idade.

Próximo jogo:
- Mostra confronto entre dois times com data e horário.
- Obrigatório:
  1. Definir os dois times.
  2. Selecionar os escudos.
  3. Informar data e horário.
  4. Informar campeonato/competição.
- Opcional:
  5. Informar local.

Patrocinador:
- Mostra o escudo do time junto com logos de patrocinadores/apoiadores.
- Obrigatório:
  1. Título da arte.
  2. Escudo do time.
  3. Enviar logos dos patrocinadores.
- Opcional:
  4. Texto principal.

Próximo jogo jogador:
- Arte de próximo jogo com foco em um jogador.
- Obrigatório:
  1. Definir os dois times.
  2. Escudo do time.
  3. Foto do jogador.
  4. Data e horário.
  5. Campeonato/competição.
- Opcional:
  6. Local.

Resultado jogador:
- Arte de resultado com foco no jogador.
- Obrigatório:
  1. Definir os times.
  2. Definir o placar.
  3. Selecionar os escudos.
  4. Enviar foto do jogador.
- Opcional:
  5. Frase.
  6. Campeonato/competição.

Jogador + escudo:
- Arte simples com jogador e escudo do time.
- Obrigatório:
  1. Nome do jogador.
  2. Escudo do time.
  3. Foto do jogador.
- Opcional:
  Nenhum.

PEDIDOS DO CLIENTE:
${JSON.stringify(resumoPedidos, null, 2)}

MENSAGEM DO CLIENTE:
${String(mensagem).trim()}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Você é o suporte automático da IA4Tube. Responda curto, claro e em português do Brasil." },
          { role: "user", content: prompt }
        ],
        max_tokens: 220,
        temperature: 0.3
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "Erro ao chamar IA",
        detalhe: data?.error?.message || ""
      });
    }

    const resposta = data.choices?.[0]?.message?.content?.trim();
    const respostaFinal = (resposta || "Não consegui responder agora.").trim()
      + "\n\nQuer continuar conversando com o robô ou prefere falar com humano?";

    const conversa = salvarMensagemSuporteAberta(whatsapp, mensagem, respostaFinal, "ia");

    const respostaLower = respostaFinal.toLowerCase();

    if (
      (respostaLower.includes("encaminhar") && respostaLower.includes("suporte")) ||
      respostaLower.includes("suporte humano") ||
      respostaLower.includes("falar com suporte") ||
      respostaLower.includes("entrar em contato com o suporte") ||
      respostaLower.includes("recomendo que você entre em contato")
    ) {
      conversa.precisa_humano = true;
      conversa.status = "aguardando_suporte";

      const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
      const idx = abertas.findIndex(c => c.id === conversa.id);
      if(idx >= 0){
        abertas[idx] = conversa;
        writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
      }
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      modo_humano: !!conversa.precisa_humano,
      resposta: respostaFinal,
      mostrar_opcoes_pos_ia: true,
      opcoes_pos_ia: [
        { texto: "Continuar com robô", valor: "continuar_robo" },
        { texto: "Falar com humano", valor: "falar_humano" }
      ]
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Erro no suporte"
    });
  }
});

app.get("/suporte/minhas-mensagens", auth, (req, res) => {
  try {
    const chatAberto = String(req.headers["x-ia4-chat"] || "") === "true";

    registrarOnline(req, { chat_aberto: chatAberto, ultima_acao: "suporte_poll" });

    const whatsapp = req.user.whatsapp;
    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

    if (!conversa) {
      return res.json({
        ok: true,
        conversa: null,
        mensagens: [],
        tem_mensagem_nova: false
      });
    }

    const temMensagemNova = conversa.cliente_leu === false;

    if (chatAberto) {
      conversa.cliente_leu = true;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      conversa,
      mensagens: conversa.mensagens || [],
      tem_mensagem_nova: temMensagemNova
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" });
  }
});

app.get("/bot/eventos-clientes", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const limite = Math.min(Number(req.query.limite || 1000), 5000);

    const agora = new Date();
    const yyyy = agora.getFullYear();
    const mm = String(agora.getMonth() + 1).padStart(2, "0");
    const dd = String(agora.getDate()).padStart(2, "0");

    const analyticsDiaFile = path.join(
      ANALYTICS_DIR,
      `${yyyy}-${mm}-${dd}.json`
    );

    const eventos = readJsonArraySafe(analyticsDiaFile).slice(-limite);

    return res.json({
      ok: true,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_clientes" });
  }
});

app.get("/bot/analytics-dia/:data", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const data = String(req.params.data || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({
        ok: false,
        error: "Data inválida. Use YYYY-MM-DD."
      });
    }

    const analyticsDiaFile = path.join(ANALYTICS_DIR, `${data}.json`);

    if (!fs.existsSync(analyticsDiaFile)) {
      return res.status(404).json({
        ok: false,
        error: "Arquivo de analytics não encontrado para esta data.",
        data
      });
    }

    const eventos = readJsonArraySafe(analyticsDiaFile);

    return res.json({
      ok: true,
      data,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "erro_analytics_dia"
    });
  }
});

app.get("/bot/eventos-pedido/:id", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const basePedido = getPedidoBaseGlobal(req.params.id);

    if (!basePedido) {
      return res.status(404).json({ ok:false, error:"Pedido não encontrado" });
    }

    const eventosPedidoFile = path.join(basePedido, "eventos_cliente.json");
    const eventos = readJsonArraySafe(eventosPedidoFile);

    return res.json({
      ok:true,
      pedido_id:req.params.id,
      total:eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_pedido" });
  }
});

app.get("/bot/online", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    return res.json({
      ok: true,
      usuarios: listarOnlineRecentes()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar online" });
  }
});

app.post("/bot/suporte/erro-pedido", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const { pedido_id, whatsapp, motivo } = req.body || {};

    if (!pedido_id || !whatsapp) {
      return res.status(400).json({ ok:false, error:"pedido_id e whatsapp obrigatórios" });
    }

    const basePedido = getPedidoBaseGlobal(pedido_id);

    if (basePedido) {
      try {
        writeOrderStatus(basePedido, orderStatus.ORDER_STATUS.ERRO);

        const pedidoPath = path.join(basePedido, "pedido.json");
        const pedidoData = safeReadJson(pedidoPath) || {};

        pedidoData.status = "erro";
        pedidoData.erro_cliente = true;
        pedidoData.motivo_erro = motivo || "erro_pipeline";
        pedidoData.erro_em = new Date().toISOString();

        fs.writeFileSync(
          pedidoPath,
          JSON.stringify(pedidoData, null, 2),
          "utf8"
        );
      } catch {}
    }

    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      "",
      `⚠️ Seu pedido ${pedido_id} entrou em análise.\n\nSua imagem não passou na nossa política de privacidade ou ocorreu algum erro no processamento automático.\n\nVeja o SUPORTE abaixo para acompanhar o atendimento.\n\nNossa equipe vai verificar o caso. Se necessário, o valor será devolvido em saldo na sua conta.`,
      "sistema"
    );

    conversa.precisa_humano = true;
    conversa.status = "aguardando_suporte";
    conversa.motivo = motivo || "erro_pipeline";
    conversa.ultima_atualizacao = new Date().toISOString();
    conversa.cliente_leu = false;

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);

    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok:true,
      conversa_id: conversa.id
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"erro_avisar_suporte" });
  }
});

function resolverWhatsappDestinoSuporte(destino) {
  destino = String(destino || "").trim();

  if (!destino) return "";

  const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
  const conversa = abertas.find(c => c.id === destino && !c.finalizada);

  if (conversa?.whatsapp) {
    return conversa.whatsapp;
  }

  const clientes = readClientes();

  if (clientes[destino]) {
    return destino;
  }

  const basePedido = getPedidoBaseGlobal(destino);

  if (basePedido) {
    const pedidoPath = path.join(basePedido, "pedido.json");
    const pedido = safeReadJson(pedidoPath) || {};

    if (pedido.whatsapp) {
      return pedido.whatsapp;
    }
  }

  return "";
}

app.post("/bot/suporte/enviar-cliente", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const { destino, mensagem } = req.body || {};
    const texto = String(mensagem || "").trim();

    if (!destino || !texto) {
      return res.status(400).json({
        ok:false,
        error:"destino e mensagem obrigatórios"
      });
    }

    const whatsapp = resolverWhatsappDestinoSuporte(destino);

    if (!whatsapp) {
      return res.status(404).json({
        ok:false,
        error:"Cliente não encontrado por esse ID, WhatsApp ou pedido."
      });
    }

    const conversa = salvarMensagemSuporteAberta(
      whatsapp,
      "",
      texto,
      "humano"
    );

    conversa.precisa_humano = true;
    conversa.status = "humano_assumiu";
    conversa.ultima_atualizacao = new Date().toISOString();
    conversa.cliente_leu = false;

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === conversa.id);

    if (idx >= 0) {
      abertas[idx] = conversa;
      writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);
    }

    return res.json({
      ok:true,
      conversa_id: conversa.id,
      whatsapp
    });
  } catch {
    return res.status(500).json({
      ok:false,
      error:"erro_enviar_mensagem_cliente"
    });
  }
});

app.get("/bot/suporte/abertas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const conversas = readJsonArraySafe(SUPORTE_ABERTAS_FILE)
      .filter(c => !c.finalizada)
      .sort((a, b) => new Date(b.ultima_atualizacao || b.inicio) - new Date(a.ultima_atualizacao || a.inicio));

    return res.json({
      ok: true,
      conversas
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar suporte aberto" });
  }
});

app.post("/bot/suporte/:id/assumir", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok:false, error:"Acesso negado" });
    }

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === req.params.id && !c.finalizada);

    if (idx === -1) {
      return res.status(404).json({ ok:false, error:"Conversa não encontrada" });
    }

    abertas[idx].status = "humano_assumiu";
    abertas[idx].precisa_humano = true;
    abertas[idx].cliente_leu = false;
    abertas[idx].ultima_atualizacao = new Date().toISOString();

    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);

    return res.json({ ok:true });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_assumir" });
  }
});

app.post("/bot/suporte/:id/responder", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const { mensagem } = req.body || {};
    const texto = String(mensagem || "").trim();

    if (!texto) {
      return res.status(400).json({ ok: false, error: "Mensagem vazia" });
    }

    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const idx = abertas.findIndex(c => c.id === req.params.id && !c.finalizada);

    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Conversa não encontrada" });
    }

    abertas[idx].mensagens = abertas[idx].mensagens || [];
    abertas[idx].mensagens.push({
      id: `${Date.now()}_humano`,
      data: new Date().toISOString(),
      autor: "humano",
      texto
    });

    abertas[idx].status = "humano_assumiu";
    abertas[idx].precisa_humano = true;
    abertas[idx].ultima_atualizacao = new Date().toISOString();

    writeJsonSafe(SUPORTE_ABERTAS_FILE, abertas);

    return res.json({ ok: true, conversa: abertas[idx] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao responder suporte" });
  }
});

app.post("/suporte/finalizar", auth, (req, res) => {
  try {
    const whatsapp = req.user.whatsapp;
    const { motivo } = req.body || {};

    const finalizou = finalizarConversaSuporte(whatsapp, motivo || "cliente_fechou_chat");

    if (!finalizou) {
      return res.json({ ok: true, sem_conversa_aberta: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao finalizar suporte" });
  }
});

app.get("/bot/suporte/finalizadas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const finalizadasPath = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
    const conversas = readJsonArraySafe(finalizadasPath);

    return res.json({
      ok: true,
      conversas
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar suporte finalizado" });
  }
});

app.post("/bot/suporte/limpar-finalizadas", auth, (req, res) => {
  try {
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const finalizadasPath = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
    writeJsonSafe(finalizadasPath, []);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao limpar suporte finalizado" });
  }
});

setInterval(finalizarConversasSuporteInativas, 60 * 1000);

app.listen(PORT, () => {
  console.log("API rodando na porta", PORT);
});
