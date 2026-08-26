const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const archiverModule = require("archiver");
const crypto = require("crypto");
const productsRegistry = require("./src/products");
const orderStorage = require("./src/orders/order.storage");
const orderStatus = require("./src/orders/order.status");
const orderService = require("./src/orders/order.service");
const productAuditService = require("./src/orders/product-audit.service");
const resultScenarioRegistry = require("./src/orders/result-scenario-registry");
const uploadContentHash = require("./src/orders/upload-content-hash");
const billingService = require("./src/billing/billing.service");
const {
  DownloadTicketStore,
  attachmentContentDisposition,
  safeDownloadFilename
} = require("./src/download/download-ticket");
const {
  BrowserHandoffStore,
  BrowserHandoffStoreError
} = require("./src/auth/browser-handoff-store");
const { createRadarConfig } = require("./src/config/radar");
const { createCorsOriginAllowlist } = require("./src/config/cors");
const { readJwtSecret } = require("./src/config/auth");
const { getBuildInfo } = require("./src/config/build-info");
const { createPool, checkDatabase, getMigrationStatus } = require("./src/db/pool");
const { createRadarObservability } = require("./src/observability/radar-observability");
const { createHealthRouter } = require("./src/health/health.routes");
const { clientIp: resolveClientIp } = require("./src/security/client-ip");
const { createFriendliesRouter } = require("./src/friendlies/friendlies.routes");
const { createRadarIdentityRouter } = require("./src/friendlies/radar-identity.routes");
const {
  createInstagramVerificationRouter,
  createInstagramVerificationAdminRouter
} = require("./src/friendlies/instagram-verification.routes");
const {
  createProfilePrintImportRouter
} = require("./src/friendlies/profile-print-import.routes");
const {
  createProfilePrintImportRepository
} = require("./src/friendlies/profile-print-import.repository");
const {
  createAvailabilityRouter
} = require("./src/friendlies/availability.routes");
const {
  createFriendlySearchRouter
} = require("./src/friendlies/friendly-search.routes");
const {
  createInvitationRouters
} = require("./src/friendlies/invitation.routes");
const {
  createMatchCenterRouter
} = require("./src/friendlies/match-center.routes");
const {
  createMatchResultRouter
} = require("./src/friendlies/match-result.routes");
const {
  createMatchHistoryRouter
} = require("./src/friendlies/match-history.routes");
const {
  createTeamReputationRouters
} = require("./src/friendlies/team-reputation.routes");
const {
  createRadarModerationRouters
} = require("./src/friendlies/radar-moderation.routes");
const { createRadarWhatsappRouter } = require("./src/friendlies/radar-whatsapp.routes");
const { createMatchCommunicationRouter } = require("./src/friendlies/match-communication.routes");
const { createRadarIdentityRepository } = require("./src/friendlies/radar-identity.repository");
const { createRadarAccountSynchronizer } = require("./src/friendlies/radar-account-sync");
const {
  createLegacyRadarIdentityResolver,
  accountReference
} = require("./src/friendlies/radar-identity.policy");

function criarArquivoZip(options = {}) {
  if (typeof archiverModule === "function") {
    return archiverModule("zip", options);
  }

  if (typeof archiverModule?.ZipArchive === "function") {
    return new archiverModule.ZipArchive(options);
  }

  throw new Error("Modulo de compactacao ZIP indisponivel.");
}

const app = express();

// ===== CONFIG BÁSICA =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = readJwtSecret();
const radarConfig = createRadarConfig();
const radarObservability = createRadarObservability({ service: "omascote-api" });
const radarLogger = radarObservability.logger;
const radarPool = createPool(radarConfig, { observer: radarObservability });
const buildInfo = getBuildInfo();
const DOWNLOAD_TICKET_TTL_MS = Math.min(
  Math.max(Number(process.env.DOWNLOAD_TICKET_TTL_MS || 90_000), 30_000),
  5 * 60 * 1000
);
const downloadTickets = new DownloadTicketStore({ ttlMs: DOWNLOAD_TICKET_TTL_MS });

// ===== DATA STORAGE (RENDER DISK) =====
const isRender = process.env.RENDER || process.env.NODE_ENV === "production";

const DATA_DIR = process.env.OMASCOTE_DATA_DIR
  ? path.resolve(process.env.OMASCOTE_DATA_DIR)
  : isRender
    ? "/var/data"
    : path.join(__dirname, "dados");

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const BOT_ADMIN_WHATSAPP = process.env.BOT_ADMIN_WHATSAPP || "15991120599";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";
const MP_SANDBOX_MODE = String(
  process.env.MP_SANDBOX_MODE || ""
).toLowerCase() === "true";
const MP_WEBHOOK_SECRET = String(process.env.MP_WEBHOOK_SECRET || "").trim();
const PUBLIC_API_BASE_URL = String(
  process.env.PUBLIC_API_BASE_URL || "https://api.omascote.com.br"
).replace(/\/+$/, "");
const MP_PROCESSADOS_FILE = path.join(DATA_DIR, "mp_processados.json");
const MP_ORDERS_V2_FILE = path.join(DATA_DIR, "mp_orders_v2.json");
const MP_ORDERS_V2_EVENTS_FILE = path.join(DATA_DIR, "mp_orders_v2_events.jsonl");
const MP_ORDERS_V2_VERSION = "orders_v2_20260729";
const MP_ORDERS_V2_TIMEOUT_MS = Math.min(
  Math.max(
    Number(process.env.MP_ORDERS_V2_TIMEOUT_MS || 8_000),
    process.env.NODE_ENV === "test" ? 25 : 1_000
  ),
  20_000
);
const MP_ORDERS_V2_CREATE_ENABLED = !["0", "false", "off"].includes(
  String(process.env.MP_ORDERS_V2_CREATE_ENABLED || "true").trim().toLowerCase()
);
const TEMPO_ESTIMADO_FILE = path.join(DATA_DIR, "tempo_estimado.json");
const ONLINE_FILE = path.join(DATA_DIR, "usuarios_online.json");
const SUPORTE_ABERTAS_FILE = path.join(DATA_DIR, "suporte_conversas_abertas.json");
const SUPORTE_FINALIZADAS_FILE = path.join(DATA_DIR, "suporte_conversas_finalizadas.json");
const PREVIEW_LIMITER_FILE = path.join(DATA_DIR, "preview_limiter.json");
const FOTO_JOGOS_RATE_LIMIT_FILE = path.join(DATA_DIR, "foto_jogos_rate_limit.json");
const SALDO_TRANSACOES_FILE = path.join(DATA_DIR, "saldo_transacoes.json");
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
const SOLICITACOES_EXCLUSAO_CONTA_FILE = path.join(DATA_DIR, "solicitacoes_exclusao_conta.json");
const DENUNCIAS_CONTEUDO_IA_FILE = path.join(DATA_DIR, "denuncias_conteudo_ia.json");
const AUTH_BROWSER_HANDOFF_FILE = process.env.AUTH_BROWSER_HANDOFF_FILE
  ? path.resolve(process.env.AUTH_BROWSER_HANDOFF_FILE)
  : path.join(DATA_DIR, "auth_browser_handoffs.json");
const PREVIEW_LIMITER_MAX = 3;
const PREVIEW_LIMITER_TTL_MS = 6 * 60 * 60 * 1000;
const FOTO_JOGOS_RATE_LIMIT_MINUTE_MS = 60 * 1000;
const FOTO_JOGOS_RATE_LIMIT_DAY_MS = 24 * 60 * 60 * 1000;
const FOTO_JOGOS_RATE_LIMIT_PENDING_TTL_MS = 5 * 60 * 1000;
const FOTO_JOGOS_RATE_LIMIT_MAX_PER_MINUTE = 3;
const FOTO_JOGOS_RATE_LIMIT_MAX_PER_DAY = 30;
const FOTO_JOGOS_RATE_LIMIT_MAX_PER_IP_MINUTE = 12;
const FOTO_JOGOS_ANALYSIS_DEDUPE_TTL_MS = 15 * 60 * 1000;
const AUTH_BROWSER_HANDOFF_ORIGINS = new Set([
  "https://omascote.com.br",
  "https://www.omascote.com.br"
]);
const authBrowserHandoffs = new BrowserHandoffStore({
  filePath: AUTH_BROWSER_HANDOFF_FILE,
  ttlMs: process.env.AUTH_BROWSER_HANDOFF_TTL_MS || 180_000,
  rateWindowMs: process.env.AUTH_BROWSER_HANDOFF_RATE_WINDOW_MS || 10 * 60 * 1000,
  issueUserLimit: process.env.AUTH_BROWSER_HANDOFF_ISSUE_USER_LIMIT || 3,
  issueIpLimit: process.env.AUTH_BROWSER_HANDOFF_ISSUE_IP_LIMIT || 10,
  redeemIpLimit: process.env.AUTH_BROWSER_HANDOFF_REDEEM_IP_LIMIT || 20,
  identifierSecret: JWT_SECRET
});

const CLIENTES_TESTE = [
  "Los Hermanos",
  "TESTE",
  "admin"
];

app.set("trust proxy", radarConfig.trustedProxyHops);
app.use(radarObservability.requestContext);
app.use(radarObservability.httpMetrics);

// CORS: permite somente origens explicitamente confiaveis.
app.use(cors({
  origin: createCorsOriginAllowlist(),
  credentials: false
}));

const authBrowserHandoffJsonParser = express.json({ limit: "2kb" });
app.use("/auth/browser-handoff", (req, res, next) => {
  if (req.method !== "POST") return next();

  const contentLength = Number(req.headers["content-length"] || 0);
  const hasBody = contentLength > 0 || Boolean(req.headers["transfer-encoding"]);

  if (Number.isFinite(contentLength) && contentLength > 2 * 1024) {
    setPrivateBrowserHandoffHeaders(res);
    logAuthBrowserHandoff(req, {
      evento: "handoff_payload_recusado",
      status: 413,
      motivo: "invalid"
    });
    return res.status(413).json({
      ok: false,
      error: "Dados de transferencia muito grandes."
    });
  }

  if (hasBody && !req.is("application/json")) {
    setPrivateBrowserHandoffHeaders(res);
    logAuthBrowserHandoff(req, {
      evento: "handoff_payload_recusado",
      status: 415,
      motivo: "invalid"
    });
    return res.status(415).json({
      ok: false,
      error: "Envie os dados de transferencia em formato JSON."
    });
  }

  return authBrowserHandoffJsonParser(req, res, error => {
    if (!error) return next();

    setPrivateBrowserHandoffHeaders(res);
    const tooLarge = error?.type === "entity.too.large";
    logAuthBrowserHandoff(req, {
      evento: "handoff_payload_recusado",
      status: tooLarge ? 413 : 400,
      motivo: "invalid"
    });
    return res.status(tooLarge ? 413 : 400).json({
      ok: false,
      error: tooLarge
        ? "Dados de transferencia muito grandes."
        : "Dados de transferencia invalidos."
    });
  });
});

const generalJsonParser = express.json({ limit: "50mb" });
app.use((req, res, next) => {
  if (
    req.path === "/me/time/radar" ||
    req.path.startsWith("/me/time/radar/") ||
    req.path === "/me/time/verificacao" ||
    req.path.startsWith("/me/time/verificacoes/") ||
    req.path === "/me/time/perfil/importar-print" ||
    req.path === "/admin/radar/verificacoes" ||
    req.path.startsWith("/admin/radar/verificacoes/") ||
    req.path === "/admin/radar/moderacao" ||
    req.path.startsWith("/admin/radar/moderacao/")
    || req.path === "/me/time/amistosos"
    || req.path.startsWith("/me/time/amistosos/")
  ) {
    return next();
  }
  return generalJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: "8kb" }));
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

if (!fs.existsSync(FOTO_JOGOS_RATE_LIMIT_FILE)) {
  fs.writeFileSync(FOTO_JOGOS_RATE_LIMIT_FILE, JSON.stringify([], null, 2), "utf8");
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

if (!fs.existsSync(SOLICITACOES_EXCLUSAO_CONTA_FILE)) {
  fs.writeFileSync(SOLICITACOES_EXCLUSAO_CONTA_FILE, JSON.stringify([], null, 2), "utf8");
}

if (!fs.existsSync(DENUNCIAS_CONTEUDO_IA_FILE)) {
  fs.writeFileSync(DENUNCIAS_CONTEUDO_IA_FILE, JSON.stringify([], null, 2), "utf8");
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

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

function writePedidoAtomic(base, pedido) {
  writeJsonAtomic(path.join(base, "pedido.json"), pedido);
}

function readMpOrdersV2() {
  const data = safeReadJson(MP_ORDERS_V2_FILE);
  const ledger = data && typeof data === "object" && !Array.isArray(data)
    ? data
    : {};

  ledger.version = 2;
  ledger.attempts = ledger.attempts && typeof ledger.attempts === "object" && !Array.isArray(ledger.attempts)
    ? ledger.attempts
    : {};
  ledger.by_order_id = ledger.by_order_id && typeof ledger.by_order_id === "object" && !Array.isArray(ledger.by_order_id)
    ? ledger.by_order_id
    : {};
  ledger.active_by_scope = ledger.active_by_scope && typeof ledger.active_by_scope === "object" && !Array.isArray(ledger.active_by_scope)
    ? ledger.active_by_scope
    : {};

  return ledger;
}

function writeMpOrdersV2(ledger) {
  writeJsonAtomic(MP_ORDERS_V2_FILE, ledger);
}

function sanitizarEventoMercadoPago(value, depth = 0) {
  if (depth > 8) return "[limite]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizarEventoMercadoPago(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 500) : value;
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|token|secret|signature|password|qr_code|ticket_url/i.test(key)) {
      out[key] = "[redigido]";
      continue;
    }
    out[key] = sanitizarEventoMercadoPago(item, depth + 1);
  }
  return out;
}

function registrarEventoMpOrdersV2(evento, detalhes = {}) {
  const registro = {
    evento,
    registrado_em: new Date().toISOString(),
    ...sanitizarEventoMercadoPago(detalhes)
  };

  try {
    fs.appendFileSync(MP_ORDERS_V2_EVENTS_FILE, `${JSON.stringify(registro)}\n`, "utf8");
  } catch (error) {
    console.error("[MP_ORDERS_V2] falha_auditoria", {
      evento,
      erro: error?.message || "erro"
    });
  }

  console.log("[MP_ORDERS_V2]", JSON.stringify(registro));
  return registro;
}

let mpOrdersV2Queue = Promise.resolve();

function withMpOrdersV2Lock(callback) {
  const run = mpOrdersV2Queue.then(callback, callback);
  mpOrdersV2Queue = run.catch(() => {});
  return run;
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

const MODALIDADE_CRIACAO_COM_SUPORTE = "com_suporte";
const MODALIDADE_CRIACAO_ECONOMICA = "economica";
const MODALIDADES_CRIACAO = new Set([
  MODALIDADE_CRIACAO_COM_SUPORTE,
  MODALIDADE_CRIACAO_ECONOMICA
]);

function normalizarModalidadeCriacao(value) {
  const modalidade = String(value || "").trim().toLowerCase();
  return MODALIDADES_CRIACAO.has(modalidade)
    ? modalidade
    : MODALIDADE_CRIACAO_COM_SUPORTE;
}

function calcularCustoPedidoPorModalidade(custoComSuporte, modalidadeCriacao) {
  const custo = normalizarValorFinanceiro(custoComSuporte);
  return normalizarModalidadeCriacao(modalidadeCriacao) === MODALIDADE_CRIACAO_ECONOMICA
    ? normalizarValorFinanceiro(Math.max(4, custo / 2))
    : custo;
}

function obterPagamentoDaOrderMercadoPago(order) {
  const pagamentos = order?.transactions?.payments;
  return Array.isArray(pagamentos) && pagamentos.length ? pagamentos[0] : {};
}

function normalizarOrderMercadoPagoComoPagamento(order) {
  const transacao = obterPagamentoDaOrderMercadoPago(order);
  const metodo = transacao?.payment_method || {};
  const statusOrder = String(order?.status || "").toLowerCase();
  const statusTransacao = String(transacao?.status || "").toLowerCase();
  const aprovado =
    ["processed", "approved"].includes(statusOrder) ||
    ["processed", "approved"].includes(statusTransacao);

  return {
    id: String(transacao?.id || order?.id || ""),
    order_id: String(order?.id || ""),
    status: aprovado ? "approved" : (statusTransacao || statusOrder || "pending"),
    transaction_amount: normalizarValorFinanceiro(
      transacao?.amount || order?.total_amount
    ),
    currency_id: String(
      transacao?.currency_id ||
      order?.currency_id ||
      (String(order?.country_code || "").toUpperCase() === "BRA" ? "BRL" : "")
    ).toUpperCase(),
    external_reference: order?.external_reference || "",
    metadata: order?.metadata || {},
    payer: order?.payer || transacao?.payer || {},
    point_of_interaction: {
      transaction_data: {
        qr_code: metodo?.qr_code || "",
        qr_code_base64: metodo?.qr_code_base64 || "",
        ticket_url: metodo?.ticket_url || ""
      }
    }
  };
}

function criarReferenciaExternaPedidoPix(whatsapp, pedidoId, modalidadeCriacao) {
  const telefone = String(whatsapp || "").replace(/\D/g, "");
  const id = String(pedidoId || "").replace(/[^A-Za-z0-9_]/g, "");
  const modalidade = normalizarModalidadeCriacao(modalidadeCriacao) ===
    MODALIDADE_CRIACAO_ECONOMICA
    ? "e"
    : "s";
  return `px_${telefone}_${id}_${modalidade}`;
}

function criarReferenciaExternaLotePix(whatsapp, batchId) {
  const telefone = String(whatsapp || "").replace(/\D/g, "");
  const loteRef = crypto
    .createHash("sha256")
    .update(`${telefone}|${String(batchId || "")}`)
    .digest("hex")
    .slice(0, 24);
  return `pxl_${telefone}_${loteRef}`;
}

function extrairReferenciaExternaPedidoPix(externalReference) {
  const external = String(externalReference || "");

  const lote = external.match(/^pxl_(\d+)_([A-Za-z0-9_]+)$/);
  if (lote) {
    return {
      whatsapp: lote[1],
      batch_ref: lote[2],
      tipo: "pedido_pix_lote"
    };
  }

  if (external.startsWith("pedido_pix|")) {
    const partes = external.split("|");
    return {
      whatsapp: partes[1] || "",
      pedido_id: partes[2] || "",
      modalidade_criacao: partes[4] || ""
    };
  }

  const compacta = external.match(/^px_(\d+)_([A-Za-z0-9_]+)_([es])$/);
  if (compacta) {
    return {
      whatsapp: compacta[1],
      pedido_id: compacta[2],
      modalidade_criacao:
        compacta[3] === "e"
          ? MODALIDADE_CRIACAO_ECONOMICA
          : MODALIDADE_CRIACAO_COM_SUPORTE
    };
  }

  if (!external.startsWith("pedido_pix_")) return null;

  try {
    const conteudo = Buffer.from(
      external.slice("pedido_pix_".length),
      "base64url"
    ).toString("utf8");
    const partes = conteudo.split("|");
    return {
      whatsapp: partes[0] || "",
      pedido_id: partes[1] || "",
      modalidade_criacao: partes[2] || ""
    };
  } catch {
    return null;
  }
}

function validarAssinaturaWebhookMercadoPago(req) {
  if (!MP_WEBHOOK_SECRET) return true;

  const assinatura = String(req.headers?.["x-signature"] || "");
  const requestId = String(req.headers?.["x-request-id"] || "");
  const dataId = String(
    req.query?.["data.id"] ||
    req.query?.data_id ||
    req.body?.data?.id ||
    ""
  ).toLowerCase();
  const partes = Object.fromEntries(
    assinatura
      .split(",")
      .map(item => item.split("=", 2).map(value => value.trim()))
      .filter(item => item.length === 2 && item[0] && item[1])
  );
  const timestamp = String(partes.ts || "");
  const hashRecebido = String(partes.v1 || "").toLowerCase();

  if (!timestamp || !hashRecebido) return false;

  let manifest = "";
  if (dataId) manifest += `id:${dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${timestamp};`;

  const hashEsperado = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");
  const esperado = Buffer.from(hashEsperado, "hex");
  const recebido = Buffer.from(hashRecebido, "hex");

  return (
    esperado.length === recebido.length &&
    esperado.length > 0 &&
    crypto.timingSafeEqual(esperado, recebido)
  );
}

const CREDITOS_SALDO_PERMITIDOS = new Set([800, 1800, 2800, 4800]);

function normalizarValorFinanceiro(valor) {
  const numero = Number(valor || 0);
  return Number.isFinite(numero) ? Number(numero.toFixed(2)) : 0;
}

function valorFinanceiroEmCentavos(valor) {
  return Math.round(normalizarValorFinanceiro(valor) * 100);
}

let mpOrdersV2TestHooks = {};

function pedidoUsaMpOrdersV2(pedido) {
  return String(pedido?.payment_flow_version || "") === MP_ORDERS_V2_VERSION;
}

function criarErroMpOrdersV2(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = Number(options.status || 500);
  error.retryable = options.retryable === true;
  error.detalhe = options.detalhe;
  return error;
}

async function requestMercadoPagoOrdersV2(endpoint, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MP_ORDERS_V2_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(`https://api.mercadopago.com${endpoint}`, {
      ...options,
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
  } catch (error) {
    const timeout = error?.name === "AbortError";
    throw criarErroMpOrdersV2(
      timeout ? "MP_TIMEOUT" : "MP_UNAVAILABLE",
      timeout
        ? "O Mercado Pago demorou para responder."
        : "O Mercado Pago esta temporariamente indisponivel.",
      { status: 503, retryable: true }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    const retryable = response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    throw criarErroMpOrdersV2(
      "MP_HTTP_ERROR",
      retryable
        ? "O Mercado Pago nao conseguiu concluir a operacao agora."
        : "O Mercado Pago recusou a operacao.",
      {
        status: retryable ? 503 : 502,
        retryable,
        detalhe: {
          http_status: response.status,
          error: payload?.error || payload?.message || ""
        }
      }
    );
  }

  return {
    response,
    payload
  };
}

async function obterOrderMercadoPagoV2(orderId) {
  const id = String(orderId || "").trim();
  if (!id) {
    throw criarErroMpOrdersV2("ORDER_ID_AUSENTE", "Order sem identificador.", {
      status: 400
    });
  }
  const resultado = await requestMercadoPagoOrdersV2(
    `/v1/orders/${encodeURIComponent(id)}`
  );
  return resultado.payload;
}

function normalizarEstadoOrderV2(order) {
  const pagamento = obterPagamentoDaOrderMercadoPago(order);
  const orderStatus = String(order?.status || "").trim().toLowerCase();
  const paymentStatus = String(pagamento?.status || "").trim().toLowerCase();
  const statusDetail = String(
    pagamento?.status_detail || order?.status_detail || ""
  ).trim().toLowerCase();
  const countryCode = String(order?.country_code || "").trim().toUpperCase();
  const moedaInformada = String(
    pagamento?.currency_id ||
    pagamento?.currency ||
    order?.currency_id ||
    order?.currency ||
    ""
  ).trim().toUpperCase();
  const currency = moedaInformada ||
    (["BRA", "BR"].includes(countryCode) ? "BRL" : "");
  const terminalStatuses = new Set([
    "cancelled",
    "canceled",
    "expired",
    "failed",
    "rejected"
  ]);

  return {
    order_id: String(order?.id || ""),
    payment_id: String(pagamento?.id || ""),
    order_status: orderStatus,
    payment_status: paymentStatus,
    status_detail: statusDetail,
    total_amount: normalizarValorFinanceiro(order?.total_amount),
    payment_amount: normalizarValorFinanceiro(pagamento?.amount),
    currency,
    country_code: countryCode,
    external_reference: String(order?.external_reference || ""),
    aprovado:
      orderStatus === "processed" &&
      paymentStatus === "processed" &&
      statusDetail === "accredited",
    terminal:
      terminalStatuses.has(orderStatus) ||
      terminalStatuses.has(paymentStatus),
    terminal_status: terminalStatuses.has(paymentStatus)
      ? paymentStatus
      : terminalStatuses.has(orderStatus)
        ? orderStatus
        : ""
  };
}

function scopeKeyMpOrdersV2({ ownerId, flow, pedidoIds, batchId }) {
  if (flow === "batch") {
    return `batch|${String(ownerId)}|${String(batchId || "")}`;
  }
  return `individual|${String(ownerId)}|${String(pedidoIds?.[0] || "")}`;
}

function criarTentativaMpOrdersV2({ ownerId, flow, itens, batchId, valor }) {
  const attemptId = crypto.randomBytes(12).toString("hex");
  const pedidoIds = itens.map(item => String(item.id));
  const scopeKey = scopeKeyMpOrdersV2({
    ownerId,
    flow,
    pedidoIds,
    batchId
  });
  const agora = new Date().toISOString();

  return {
    attempt_id: attemptId,
    version: MP_ORDERS_V2_VERSION,
    scope_key: scopeKey,
    flow,
    owner_id: String(ownerId),
    pedido_ids: pedidoIds,
    order_items: itens.map(item => ({
      pedido_id: String(item.id),
      expected_amount: normalizarValorFinanceiro(
        item.pedido?.valor_pendente || item.pedido?.valor_final
      )
    })),
    batch_id: flow === "batch" ? String(batchId || "") : "",
    expected_amount: normalizarValorFinanceiro(valor),
    expected_currency: "BRL",
    external_reference: `omv2_${attemptId}`,
    idempotency_key: `omascote_orders_v2_${attemptId}`,
    state: "creating",
    effects: {},
    created_at: agora,
    updated_at: agora
  };
}

function obterTentativaPorOrderIdMpOrdersV2(ledger, orderId, order = null) {
  const id = String(orderId || "");
  let attemptId = String(ledger.by_order_id?.[id] || "");

  if (!attemptId && order) {
    const external = String(order.external_reference || "");
    const match = external.match(/^omv2_([a-f0-9]{24})$/);
    if (match && ledger.attempts?.[match[1]]) {
      attemptId = match[1];
      ledger.by_order_id[id] = attemptId;
    }
  }

  return attemptId ? ledger.attempts?.[attemptId] || null : null;
}

function carregarItensLocaisMpOrdersV2(attempt) {
  return (Array.isArray(attempt?.pedido_ids) ? attempt.pedido_ids : []).map(pedidoId => {
    const base = getPedidoBase(attempt.owner_id, pedidoId);
    const pedido = base ? readPedido(base) || {} : null;
    return {
      id: String(pedidoId),
      base,
      pedido
    };
  });
}

function validarItensLocaisMpOrdersV2(attempt, estado, options = {}) {
  if (options.expectedOwnerId &&
      String(options.expectedOwnerId) !== String(attempt.owner_id)) {
    return { ok: false, reason: "proprietario_divergente" };
  }
  if (options.expectedPedidoId &&
      !attempt.pedido_ids.includes(String(options.expectedPedidoId))) {
    return { ok: false, reason: "pedido_divergente" };
  }

  const itens = carregarItensLocaisMpOrdersV2(attempt);
  if (!itens.length || itens.some(item => !item.base || !item.pedido)) {
    return { ok: false, reason: "pedido_nao_encontrado", itens };
  }

  const snapshotById = new Map(
    (attempt.order_items || []).map(item => [String(item.pedido_id), item])
  );
  let somaLocal = 0;

  for (const item of itens) {
    const pedido = item.pedido;
    const snapshot = snapshotById.get(item.id);
    const valorLocal = normalizarValorFinanceiro(
      pedido.valor_pendente || pedido.valor_final
    );
    const valorEsperadoItem = normalizarValorFinanceiro(
      snapshot?.expected_amount
    );
    const confirmadoMesmaOrder =
      pedido.pagamento_pendente !== true &&
      String(pedido.payment_v2_confirmation_order_id || "") === estado.order_id;

    if (!pedidoUsaMpOrdersV2(pedido)) {
      return { ok: false, reason: "pedido_anterior_ao_v2", itens };
    }
    if (String(pedido.mp_order_id || "") !== estado.order_id) {
      return { ok: false, reason: "order_id_divergente", itens };
    }
    if (pedido.mp_payment_id &&
        estado.payment_id &&
        String(pedido.mp_payment_id) !== estado.payment_id) {
      return { ok: false, reason: "payment_id_divergente", itens };
    }
    if (!confirmadoMesmaOrder && pedido.pagamento_pendente !== true) {
      return { ok: false, reason: "pedido_liberado_por_outro_pagamento", itens };
    }
    if (valorEsperadoItem <= 0 ||
        Math.abs(valorLocal - valorEsperadoItem) >= 0.01) {
      return { ok: false, reason: "valor_item_divergente", itens };
    }

    somaLocal = normalizarValorFinanceiro(somaLocal + valorEsperadoItem);
  }

  if (Math.abs(somaLocal - normalizarValorFinanceiro(attempt.expected_amount)) >= 0.01) {
    return { ok: false, reason: "valor_lote_local_divergente", itens };
  }

  return { ok: true, itens };
}

function atualizarStatusLocalOrderV2(attempt, estado) {
  const agora = new Date().toISOString();
  const itens = carregarItensLocaisMpOrdersV2(attempt);

  for (const item of itens) {
    if (!item.base || !item.pedido || !pedidoUsaMpOrdersV2(item.pedido)) continue;
    if (String(item.pedido.mp_order_id || "") !== estado.order_id) continue;
    item.pedido.mp_order_status = estado.order_status || estado.terminal_status || "pending";
    item.pedido.mp_payment_status = estado.payment_status || estado.terminal_status || "pending";
    item.pedido.pix_status_atualizado_em = agora;
    writePedidoAtomic(item.base, item.pedido);
  }
}

function registrarBonusPrimeiraCompraOrderV2(attempt, item, estado, confirmadoEm) {
  if (attempt.flow !== "individual") return;
  const valorBonus = calcularBonusPrimeiraCompraSeguro(item.pedido, {
    transaction_amount: estado.payment_amount || estado.total_amount,
    metadata: {}
  });
  if (valorBonus <= 0) return;

  const clientes = readClientes();
  const cliente = clientes[attempt.owner_id];
  if (!cliente || cliente.primeira_compra_bonus_concedido === true) return;

  cliente.saldo_extra = Number(cliente.saldo_extra || 0) + valorBonus;
  cliente.primeira_compra_bonus_concedido = true;
  cliente.primeira_compra_bonus_valor = valorBonus;
  cliente.primeira_compra_bonus_em = confirmadoEm;
  clientes[attempt.owner_id] = cliente;
  writeClientes(clientes);

  item.pedido.bonus_primeira_compra = true;
  item.pedido.bonus_saldo_extra = valorBonus;
  item.pedido.bonus_saldo_extra_em = confirmadoEm;
  writePedidoAtomic(item.base, item.pedido);
}

async function confirmarItemOrderV2(attempt, item, estado, ledger) {
  const effectKey = String(item.id);
  attempt.effects[effectKey] = attempt.effects[effectKey] || {};
  const effects = attempt.effects[effectKey];
  let pedido = readPedido(item.base) || {};

  if (
    pedido.pagamento_pendente !== true &&
    String(pedido.payment_v2_confirmation_order_id || "") === estado.order_id
  ) {
    effects.core_confirmed = true;
  } else if (!effects.core_confirmed) {
    const confirmadoEm = new Date().toISOString();
    pedido.pagamento_pendente = false;
    pedido.pagamento_metodo = "pix";
    pedido.pagamento_confirmado_em = confirmadoEm;
    pedido.mp_payment_status = "processed";
    pedido.mp_order_status = "processed";
    pedido.payment_v2_confirmation_order_id = estado.order_id;
    pedido.payment_v2_confirmation_payment_id = estado.payment_id;
    pedido.payment_v2_confirmed_at = confirmadoEm;
    pedido.pagamento_info = {
      tipo: attempt.flow === "batch" ? "pedido_pix_lote" : "pedido_pix",
      status: "processed",
      status_detail: estado.status_detail,
      valor_pago: normalizarValorFinanceiro(
        (attempt.order_items || []).find(x => String(x.pedido_id) === item.id)?.expected_amount
      ),
      valor_lote: attempt.flow === "batch"
        ? normalizarValorFinanceiro(attempt.expected_amount)
        : undefined,
      quantidade_lote: attempt.flow === "batch"
        ? attempt.pedido_ids.length
        : undefined,
      order_id: estado.order_id,
      payment_id: estado.payment_id,
      whatsapp: attempt.owner_id,
      pedido_id: item.id,
      batch_id: attempt.batch_id || "",
      modalidade_criacao: normalizarModalidadeCriacao(pedido.modalidade_criacao),
      confirmado_em: confirmadoEm
    };
    pedido.mensagens_cliente = Array.isArray(pedido.mensagens_cliente)
      ? pedido.mensagens_cliente
      : [];
    const messageId = `msg_pagamento_order_${estado.order_id}_${item.id}`;
    if (!pedido.mensagens_cliente.some(msg => String(msg?.id || "") === messageId)) {
      pedido.mensagens_cliente.push({
        id: messageId,
        tipo: "pagamento_confirmado",
        titulo: "Pagamento confirmado",
        texto: attempt.flow === "batch"
          ? "Pagamento aprovado. Sua arte foi enviada para producao."
          : "Seu pagamento foi aprovado. Sua arte ja esta liberada ou sera liberada assim que ficar pronta.",
        lida: false,
        payment_id: estado.payment_id,
        criado_em: confirmadoEm
      });
    }
    writePedidoAtomic(item.base, pedido);
    item.pedido = pedido;
    effects.core_confirmed = true;
    effects.core_confirmed_at = confirmadoEm;
    attempt.updated_at = confirmadoEm;
    writeMpOrdersV2(ledger);

    if (process.env.NODE_ENV === "test" &&
        typeof mpOrdersV2TestHooks.afterCoreWrite === "function") {
      await mpOrdersV2TestHooks.afterCoreWrite({
        attempt,
        pedidoId: item.id
      });
    }
  } else {
    item.pedido = pedido;
  }

  pedido = readPedido(item.base) || item.pedido;
  item.pedido = pedido;
  const confirmadoEm = pedido.pagamento_confirmado_em || new Date().toISOString();

  if (!effects.bonus_checked) {
    registrarBonusPrimeiraCompraOrderV2(attempt, item, estado, confirmadoEm);
    effects.bonus_checked = true;
    writeMpOrdersV2(ledger);
  }

  if (!effects.coupon_checked) {
    const cupom = registrarUsoCupomPedido(item.pedido, attempt.owner_id, {
      idempotencyKey: `mp_order_v2|${estado.order_id}|${item.id}`
    });
    if (!cupom.ok) {
      throw criarErroMpOrdersV2(
        "CUPOM_TEMPORARIAMENTE_BLOQUEADO",
        cupom.error || "Cupom temporariamente bloqueado.",
        { status: 503, retryable: true }
      );
    }
    writePedidoAtomic(item.base, item.pedido);
    effects.coupon_checked = true;
    writeMpOrdersV2(ledger);
  }

  if (!effects.queue_released) {
    liberarPedidoEconomicoAposPagamento(item.base, item.pedido);
    effects.queue_released = true;
    writeMpOrdersV2(ledger);
  }
}

async function processarOrderV2Locked(orderId, options = {}) {
  let ledger = readMpOrdersV2();
  let order = options.prefetchedOrder || null;
  let attempt = obterTentativaPorOrderIdMpOrdersV2(ledger, orderId, order);

  if (!attempt) {
    order = order || await obterOrderMercadoPagoV2(orderId);
    attempt = obterTentativaPorOrderIdMpOrdersV2(ledger, orderId, order);
  }

  if (!attempt || attempt.version !== MP_ORDERS_V2_VERSION) {
    registrarEventoMpOrdersV2("order_ignorada_anterior_ao_v2", {
      order_id: String(orderId),
      origem: options.source || "desconhecida"
    });
    return { ok: true, ignored: true, reason: "order_anterior_ao_v2" };
  }

  if (options.expectedOwnerId &&
      String(options.expectedOwnerId) !== String(attempt.owner_id)) {
    registrarEventoMpOrdersV2("order_rejeitada_proprietario", {
      order_id: String(orderId),
      owner_binding: attempt.owner_id,
      owner_request: String(options.expectedOwnerId),
      pedido_id: String(options.expectedPedidoId || "")
    });
    return { ok: false, rejected: true, reason: "proprietario_divergente" };
  }

  order = order || await obterOrderMercadoPagoV2(orderId);
  const estado = normalizarEstadoOrderV2(order);
  const agora = new Date().toISOString();
  attempt.last_provider_status = {
    order_status: estado.order_status,
    payment_status: estado.payment_status,
    status_detail: estado.status_detail,
    checked_at: agora,
    source: options.source || "desconhecida"
  };
  attempt.updated_at = agora;

  if (estado.order_id !== String(orderId) ||
      estado.order_id !== String(attempt.mp_order_id || estado.order_id) ||
      estado.external_reference !== String(attempt.external_reference || "")) {
    attempt.state = "divergent";
    attempt.divergence_reason = "identidade_order_divergente";
    writeMpOrdersV2(ledger);
    registrarEventoMpOrdersV2("order_rejeitada_identidade", {
      order_id: String(orderId),
      attempt_id: attempt.attempt_id
    });
    return { ok: false, rejected: true, reason: attempt.divergence_reason };
  }

  if (estado.terminal) {
    attempt.state = estado.terminal_status || "terminal";
    attempt.terminal_at = agora;
    if (ledger.active_by_scope[attempt.scope_key] === attempt.attempt_id) {
      delete ledger.active_by_scope[attempt.scope_key];
    }
    writeMpOrdersV2(ledger);
    atualizarStatusLocalOrderV2(attempt, estado);
    registrarEventoMpOrdersV2("order_terminal", {
      order_id: estado.order_id,
      attempt_id: attempt.attempt_id,
      status: attempt.state,
      origem: options.source || "desconhecida"
    });
    return { ok: true, terminal: true, status: attempt.state };
  }

  if (!estado.aprovado) {
    attempt.state = "pending";
    writeMpOrdersV2(ledger);
    atualizarStatusLocalOrderV2(attempt, estado);
    return {
      ok: true,
      pending: true,
      order_status: estado.order_status,
      payment_status: estado.payment_status,
      status_detail: estado.status_detail
    };
  }

  const valorEsperado = normalizarValorFinanceiro(attempt.expected_amount);
  const valorOrderOk =
    valorEsperado > 0 &&
    estado.total_amount > 0 &&
    Math.abs(valorEsperado - estado.total_amount) < 0.01;
  const valorPagamentoOk =
    estado.payment_amount > 0 &&
    Math.abs(valorEsperado - estado.payment_amount) < 0.01;
  const moedaOk =
    String(attempt.expected_currency || "") === "BRL" &&
    estado.currency === "BRL";
  const paymentIdOk =
    !attempt.mp_payment_id ||
    !estado.payment_id ||
    String(attempt.mp_payment_id) === estado.payment_id;
  const local = validarItensLocaisMpOrdersV2(attempt, estado, options);

  if (!valorOrderOk || !valorPagamentoOk || !moedaOk || !paymentIdOk || !local.ok) {
    attempt.state = "divergent";
    attempt.divergence_reason =
      local.reason ||
      (!valorOrderOk || !valorPagamentoOk ? "valor_divergente" :
        !moedaOk ? "moeda_divergente" : "payment_id_divergente");
    attempt.divergence = {
      valor_esperado: valorEsperado,
      valor_order: estado.total_amount,
      valor_pagamento: estado.payment_amount,
      moeda: estado.currency,
      registrado_em: agora
    };
    writeMpOrdersV2(ledger);
    registrarEventoMpOrdersV2("order_rejeitada_validacao", {
      order_id: estado.order_id,
      attempt_id: attempt.attempt_id,
      reason: attempt.divergence_reason,
      valor_esperado: valorEsperado,
      valor_order: estado.total_amount,
      valor_pagamento: estado.payment_amount,
      moeda: estado.currency
    });
    return { ok: false, rejected: true, reason: attempt.divergence_reason };
  }

  attempt.state = "provider_confirmed";
  attempt.provider_confirmed_at = attempt.provider_confirmed_at || agora;
  attempt.mp_payment_id = attempt.mp_payment_id || estado.payment_id;
  writeMpOrdersV2(ledger);

  let liberados = 0;
  for (const item of local.itens) {
    const antesPendente = item.pedido.pagamento_pendente === true;
    await confirmarItemOrderV2(attempt, item, estado, ledger);
    if (antesPendente) liberados += 1;
  }

  attempt.state = "confirmed";
  attempt.confirmed_at = attempt.confirmed_at || new Date().toISOString();
  if (ledger.active_by_scope[attempt.scope_key] === attempt.attempt_id) {
    delete ledger.active_by_scope[attempt.scope_key];
  }
  writeMpOrdersV2(ledger);
  registrarEventoMpOrdersV2("order_confirmada", {
    order_id: estado.order_id,
    payment_id: estado.payment_id,
    attempt_id: attempt.attempt_id,
    owner_id: attempt.owner_id,
    pedido_ids: attempt.pedido_ids,
    flow: attempt.flow,
    liberados,
    origem: options.source || "desconhecida"
  });

  return {
    ok: true,
    confirmed: true,
    liberados,
    pedido_ids: attempt.pedido_ids
  };
}

function processarOrderV2(orderId, options = {}) {
  return withMpOrdersV2Lock(
    () => processarOrderV2Locked(orderId, options)
  );
}

function extrairDadosPixOrderV2(order) {
  const pagamento = obterPagamentoDaOrderMercadoPago(order);
  const metodo = pagamento?.payment_method || {};
  return {
    order_id: String(order?.id || ""),
    payment_id: String(pagamento?.id || ""),
    order_status: String(order?.status || "action_required"),
    payment_status: String(pagamento?.status || order?.status || "action_required"),
    pix_copia_cola: String(metodo?.qr_code || ""),
    qr_code_base64: String(metodo?.qr_code_base64 || ""),
    ticket_url: String(metodo?.ticket_url || "")
  };
}

function aplicarDadosPixOrderV2(attempt, order, ledger) {
  const pix = extrairDadosPixOrderV2(order);
  if (!pix.order_id || !pix.pix_copia_cola) {
    throw criarErroMpOrdersV2(
      "PIX_AUSENTE",
      "O Mercado Pago nao retornou o codigo PIX.",
      { status: 502 }
    );
  }

  const agora = new Date().toISOString();
  const itens = carregarItensLocaisMpOrdersV2(attempt);
  if (itens.some(item => !item.base || !item.pedido || !pedidoUsaMpOrdersV2(item.pedido))) {
    throw criarErroMpOrdersV2(
      "PEDIDO_FORA_DO_V2",
      "O pedido nao pertence ao novo fluxo de pagamento.",
      { status: 409 }
    );
  }

  attempt.mp_order_id = pix.order_id;
  attempt.mp_payment_id = pix.payment_id;
  attempt.state = "pending";
  attempt.updated_at = agora;
  ledger.by_order_id[pix.order_id] = attempt.attempt_id;
  ledger.active_by_scope[attempt.scope_key] = attempt.attempt_id;
  writeMpOrdersV2(ledger);

  for (const item of itens) {
    const pedido = readPedido(item.base) || item.pedido;
    const novaTentativaNoPedido =
      String(pedido.mp_orders_v2_attempt_id || "") !== attempt.attempt_id;
    pedido.pagamento_metodo_pendente = "pix";
    pedido.mp_order_id = pix.order_id;
    pedido.mp_payment_id = pix.payment_id;
    pedido.mp_order_status = pix.order_status;
    pedido.mp_payment_status = pix.payment_status;
    pedido.mp_orders_v2_attempt_id = attempt.attempt_id;
    pedido.pix_tentativa = novaTentativaNoPedido
      ? Math.max(1, Number(pedido.pix_tentativa || 0) + 1)
      : Math.max(1, Number(pedido.pix_tentativa || 1));
    pedido.pix_copia_cola = pix.pix_copia_cola;
    pedido.pix_qr_code_base64 = pix.qr_code_base64;
    pedido.pix_ticket_url = pix.ticket_url;
    pedido.pix_gerado_em = agora;
    if (attempt.flow === "batch") {
      pedido.pix_lote_valor = attempt.expected_amount;
      pedido.pix_lote_quantidade = attempt.pedido_ids.length;
      pedido.pix_lote_ref = attempt.attempt_id;
    }
    writePedidoAtomic(item.base, pedido);
  }

  return pix;
}

async function criarOuReutilizarOrderV2Locked({ ownerId, flow, itens, batchId = "" }) {
  if (!MP_ORDERS_V2_CREATE_ENABLED) {
    throw criarErroMpOrdersV2(
      "MP_ORDERS_V2_CREATE_DISABLED",
      "A geracao de novos pagamentos esta temporariamente pausada.",
      { status: 503, retryable: true }
    );
  }

  if (!MP_ACCESS_TOKEN) {
    throw criarErroMpOrdersV2(
      "MP_ACCESS_TOKEN_AUSENTE",
      "Mercado Pago nao configurado.",
      { status: 500 }
    );
  }
  if (!itens.length || itens.some(item => !pedidoUsaMpOrdersV2(item.pedido))) {
    throw criarErroMpOrdersV2(
      "PEDIDO_ANTERIOR_AO_V2",
      "Este pedido foi criado antes do novo fluxo de pagamento e nao sera alterado automaticamente.",
      { status: 409 }
    );
  }

  const valor = normalizarValorFinanceiro(
    itens.reduce(
      (total, item) =>
        total + Number(item.pedido.valor_pendente || item.pedido.valor_final || 0),
      0
    )
  );
  if (valor <= 0) {
    throw criarErroMpOrdersV2("VALOR_INVALIDO", "Valor pendente invalido.", {
      status: 400
    });
  }

  let ledger = readMpOrdersV2();
  const pedidoIds = itens.map(item => String(item.id));
  const scopeKey = scopeKeyMpOrdersV2({
    ownerId,
    flow,
    pedidoIds,
    batchId
  });
  let attemptId = String(ledger.active_by_scope[scopeKey] || "");
  let attempt = attemptId ? ledger.attempts[attemptId] : null;

  if (attempt?.mp_order_id) {
    const order = await obterOrderMercadoPagoV2(attempt.mp_order_id);
    const itensAtuais = carregarItensLocaisMpOrdersV2(attempt);
    const vinculoLocalPodeSerRestaurado =
      itensAtuais.length === attempt.pedido_ids.length &&
      itensAtuais.every(item =>
        item.base &&
        item.pedido &&
        pedidoUsaMpOrdersV2(item.pedido) &&
        item.pedido.pagamento_pendente === true &&
        (
          !item.pedido.mp_orders_v2_attempt_id ||
          String(item.pedido.mp_orders_v2_attempt_id) === attempt.attempt_id
        ) &&
        (
          !item.pedido.mp_order_id ||
          String(item.pedido.mp_order_id) === String(attempt.mp_order_id)
        )
      );
    if (vinculoLocalPodeSerRestaurado) {
      aplicarDadosPixOrderV2(attempt, order, ledger);
    }
    const resultado = await processarOrderV2Locked(attempt.mp_order_id, {
      source: "gerar_pix_reconsulta",
      expectedOwnerId: ownerId,
      expectedPedidoId: flow === "individual" ? pedidoIds[0] : "",
      prefetchedOrder: order
    });
    if (resultado.confirmed) {
      throw criarErroMpOrdersV2(
        "PEDIDO_JA_PAGO",
        "O pagamento ja foi confirmado.",
        { status: 409 }
      );
    }
    if (!resultado.terminal && !resultado.rejected) {
      ledger = readMpOrdersV2();
      attempt = ledger.attempts[attempt.attempt_id];
      const pix = aplicarDadosPixOrderV2(attempt, order, ledger);
      return { attempt, pix, valor, reused: true };
    }
    ledger = readMpOrdersV2();
    attempt = null;
  }

  if (!attempt) {
    attempt = criarTentativaMpOrdersV2({
      ownerId,
      flow,
      itens,
      batchId,
      valor
    });
    ledger.attempts[attempt.attempt_id] = attempt;
    ledger.active_by_scope[attempt.scope_key] = attempt.attempt_id;
    writeMpOrdersV2(ledger);
  }

  const payerEmail = MP_SANDBOX_MODE
    ? "test_user_br@testuser.com"
    : `${String(ownerId).replace(/\D/g, "") || "cliente"}@ia4tube.com.br`;
  const orderPayload = {
    type: "online",
    processing_mode: "automatic",
    total_amount: valor.toFixed(2),
    external_reference: attempt.external_reference,
    payer: { email: payerEmail },
    transactions: {
      payments: [{
        amount: valor.toFixed(2),
        payment_method: { id: "pix", type: "bank_transfer" }
      }]
    }
  };

  let order;
  try {
    const created = await requestMercadoPagoOrdersV2("/v1/orders", {
      method: "POST",
      headers: {
        "X-Idempotency-Key": attempt.idempotency_key
      },
      body: JSON.stringify(orderPayload)
    });
    order = created.payload;
  } catch (error) {
    ledger = readMpOrdersV2();
    const atual = ledger.attempts[attempt.attempt_id] || attempt;
    atual.last_error = {
      code: error.code || "MP_ERROR",
      retryable: error.retryable === true,
      registrado_em: new Date().toISOString()
    };
    atual.updated_at = new Date().toISOString();
    ledger.attempts[attempt.attempt_id] = atual;
    writeMpOrdersV2(ledger);
    throw error;
  }

  ledger = readMpOrdersV2();
  attempt = ledger.attempts[attempt.attempt_id] || attempt;
  const pix = aplicarDadosPixOrderV2(attempt, order, ledger);
  registrarEventoMpOrdersV2("order_criada", {
    order_id: pix.order_id,
    payment_id: pix.payment_id,
    attempt_id: attempt.attempt_id,
    owner_id: attempt.owner_id,
    pedido_ids: attempt.pedido_ids,
    flow: attempt.flow,
    valor
  });
  return { attempt, pix, valor, reused: false };
}

function criarOuReutilizarOrderV2(options) {
  return withMpOrdersV2Lock(
    () => criarOuReutilizarOrderV2Locked(options)
  );
}

async function tentarRecuperarOrderV2Pedido(ownerId, pedidoId, source) {
  const base = getPedidoBase(ownerId, pedidoId);
  const pedido = base ? readPedido(base) || {} : null;
  if (!base || !pedido ||
      !pedidoUsaMpOrdersV2(pedido) ||
      pedido.pagamento_pendente !== true ||
      !pedido.mp_order_id) {
    return { ok: true, skipped: true };
  }

  try {
    return await processarOrderV2(pedido.mp_order_id, {
      source,
      expectedOwnerId: ownerId,
      expectedPedidoId: pedidoId
    });
  } catch (error) {
    registrarEventoMpOrdersV2("recuperacao_indisponivel", {
      order_id: pedido.mp_order_id,
      owner_id: ownerId,
      pedido_id: pedidoId,
      origem: source,
      code: error.code || "ERRO",
      retryable: error.retryable === true
    });
    return {
      ok: false,
      temporary_error: error.retryable === true,
      reason: error.code || "ERRO"
    };
  }
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

function registrarUsoCupomPedido(pedido, whatsapp, options = {}) {
  if (!pedido?.cupom_aplicado || pedido.cupom_uso_registrado === true) return { ok: true, skipped: true };

  const codigo = normalizarCupomCodigo(pedido.cupom_codigo_normalizado || pedido.cupom_codigo || pedido.desconto_info?.cupom_codigo);
  if (!codigo) return { ok: true, skipped: true };
  const idempotencyKey = String(options.idempotencyKey || "").trim().slice(0, 180);

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

    cupom.usos_idempotencia = Array.isArray(cupom.usos_idempotencia)
      ? cupom.usos_idempotencia.map(String).slice(-5_000)
      : [];

    if (idempotencyKey && cupom.usos_idempotencia.includes(idempotencyKey)) {
      pedido.cupom_uso_registrado = true;
      pedido.cupom_uso_registrado_em = pedido.cupom_uso_registrado_em || new Date().toISOString();
      return { ok: true, skipped: true, idempotent_replay: true };
    }

    const chaveCliente = normalizarCupomCodigo(whatsapp);
    cupom.usos_total = Number(cupom.usos_total || 0) + 1;
    cupom.usos_por_cliente = cupom.usos_por_cliente && typeof cupom.usos_por_cliente === "object" && !Array.isArray(cupom.usos_por_cliente)
      ? cupom.usos_por_cliente
      : {};

    if (chaveCliente) {
      cupom.usos_por_cliente[chaveCliente] = Number(cupom.usos_por_cliente[chaveCliente] || 0) + 1;
    }

    if (idempotencyKey) {
      cupom.usos_idempotencia.push(idempotencyKey);
      cupom.usos_idempotencia = cupom.usos_idempotencia.slice(-5_000);
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

function isModoAppRequest(req) {
  const headerModoApp = String(req.headers["x-omascote-app-mode"] || "").trim().toLowerCase();
  const origemAcesso = String(req.body?.origem_acesso || req.query?.origem_acesso || "").trim().toLowerCase();
  const omascoteApp = String(req.body?.omascote_app || req.query?.omascote_app || "").trim().toLowerCase();
  const modoApp = String(req.body?.modo_app || req.query?.modo_app || "").trim().toLowerCase();

  return headerModoApp === "app" ||
    headerModoApp === "twa" ||
    origemAcesso === "app" ||
    origemAcesso === "twa" ||
    omascoteApp === "1" ||
    modoApp === "1";
}

function bloquearRecursoPagamentoNoApp(req, res) {
  if (!isModoAppRequest(req)) return false;

  res.status(403).json({
    ok: false,
    error: "Este recurso não está disponível no app."
  });
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

function findPedidoByClientRequestId(whatsapp, clientRequestId) {
  return orderStorage.findPedidoByClientRequestId(PEDIDOS_DIR, whatsapp, clientRequestId);
}

function getPreviewLimiterIp(req) {
  return resolveClientIp(req, radarConfig);
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

function pedidoEconomicoAguardandoPagamento(pedido) {
  if (!pedido) return false;
  return (
    (
      pedido.assistente_lote === true ||
      normalizarModalidadeCriacao(pedido.modalidade_criacao) === MODALIDADE_CRIACAO_ECONOMICA
    ) &&
    isPedidoSemPagamentoConfirmado(pedido)
  );
}

function liberarPedidoEconomicoAposPagamento(base, pedido) {
  if (
    (
      pedido?.assistente_lote !== true &&
      normalizarModalidadeCriacao(pedido?.modalidade_criacao) !== MODALIDADE_CRIACAO_ECONOMICA
    ) ||
    pedido?.pagamento_pendente === true
  ) {
    return false;
  }
  writeOrderStatus(base, orderStatus.ORDER_STATUS.NOVO);
  return true;
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

function readFotoJogosRateLimit() {
  return readJsonArraySafe(FOTO_JOGOS_RATE_LIMIT_FILE);
}

function writeFotoJogosRateLimit(lista) {
  writeJsonSafe(FOTO_JOGOS_RATE_LIMIT_FILE, Array.isArray(lista) ? lista : []);
}

function hashFotoJogosRateLimit(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function mascararFotoJogosIdentificador(value) {
  const texto = String(value || "").replace(/\s+/g, "").trim();
  if (!texto) return "desconhecido";
  if (texto.length <= 4) return `***${texto.slice(-2)}`;
  return `${texto.slice(0, 2)}***${texto.slice(-4)}`;
}

function getFotoJogosUsuarioIdentificador(req) {
  return String(
    req.user?.whatsapp ||
    req.user?.cliente_id ||
    req.user?.id ||
    req.user?.sub ||
    "usuario_autenticado"
  ).trim();
}

function getFotoJogosRateLimitDia(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function fotoJogosRateLimitErro(tipo) {
  const err = new Error(tipo === "diario"
    ? "Você atingiu o limite diário de análises de imagens. Tente novamente amanhã."
    : "Você fez muitas análises em pouco tempo. Aguarde alguns minutos e tente novamente.");
  err.status = 429;
  err.rateLimit = true;
  err.rateLimitTipo = tipo;
  return err;
}

function fotoJogosLogRateLimit({ tipo, usuarioMascarado, horario }) {
  console.warn("[IDENTIFICAR_JOGOS_FOTO_RATE_LIMIT]", {
    identificador: usuarioMascarado,
    horario,
    tipo
  });
}

function limparFotoJogosRateLimit(lista, agora, diaAtual) {
  return (Array.isArray(lista) ? lista : []).filter(entry => {
    const criadoEm = Number(entry?.criado_em || 0);
    if (!criadoEm) return false;
    if (agora - criadoEm <= FOTO_JOGOS_RATE_LIMIT_MINUTE_MS) return true;
    if (entry?.status === "pending" && agora - criadoEm <= FOTO_JOGOS_RATE_LIMIT_PENDING_TTL_MS) return true;
    if (entry?.status === "success" && entry?.dia === diaAtual && agora - criadoEm <= FOTO_JOGOS_RATE_LIMIT_DAY_MS * 2) return true;
    return false;
  });
}

function reservarFotoJogosRateLimit(req) {
  const agora = Date.now();
  const horario = new Date(agora).toISOString();
  const diaAtual = getFotoJogosRateLimitDia(new Date(agora));
  const usuarioIdentificador = getFotoJogosUsuarioIdentificador(req);
  const usuarioMascarado = mascararFotoJogosIdentificador(usuarioIdentificador);
  const usuarioHash = hashFotoJogosRateLimit(`foto-jogos:user:${usuarioIdentificador}`);
  const ip = getPreviewLimiterIp(req);
  const ipHash = ip ? hashFotoJogosRateLimit(`foto-jogos:ip:${ip}`) : "";
  const lista = limparFotoJogosRateLimit(readFotoJogosRateLimit(), agora, diaAtual);

  const contaMinutoUsuario = lista.filter(entry =>
    entry.user_hash === usuarioHash &&
    (agora - Number(entry.criado_em || 0)) <= FOTO_JOGOS_RATE_LIMIT_MINUTE_MS
  ).length;

  if (contaMinutoUsuario >= FOTO_JOGOS_RATE_LIMIT_MAX_PER_MINUTE) {
    fotoJogosLogRateLimit({ tipo: "minuto", usuarioMascarado, horario });
    writeFotoJogosRateLimit(lista);
    throw fotoJogosRateLimitErro("minuto");
  }

  if (ipHash) {
    const contaMinutoIp = lista.filter(entry =>
      entry.ip_hash === ipHash &&
      (agora - Number(entry.criado_em || 0)) <= FOTO_JOGOS_RATE_LIMIT_MINUTE_MS
    ).length;

    if (contaMinutoIp >= FOTO_JOGOS_RATE_LIMIT_MAX_PER_IP_MINUTE) {
      fotoJogosLogRateLimit({ tipo: "ip_minuto", usuarioMascarado, horario });
      writeFotoJogosRateLimit(lista);
      throw fotoJogosRateLimitErro("minuto");
    }
  }

  const contaDiaUsuario = lista.filter(entry =>
    entry.user_hash === usuarioHash &&
    entry.dia === diaAtual &&
    (entry.status === "success" || entry.status === "pending")
  ).length;

  if (contaDiaUsuario >= FOTO_JOGOS_RATE_LIMIT_MAX_PER_DAY) {
    fotoJogosLogRateLimit({ tipo: "diario", usuarioMascarado, horario });
    writeFotoJogosRateLimit(lista);
    throw fotoJogosRateLimitErro("diario");
  }

  const reserva = {
    id: `foto_jogos_${agora}_${crypto.randomBytes(4).toString("hex")}`,
    user_hash: usuarioHash,
    ip_hash: ipHash,
    dia: diaAtual,
    status: "pending",
    criado_em: agora,
    atualizado_em: agora
  };

  lista.push(reserva);
  writeFotoJogosRateLimit(lista);
  return reserva;
}

function finalizarFotoJogosRateLimit(reserva, status) {
  if (!reserva?.id) return;

  const agora = Date.now();
  const diaAtual = getFotoJogosRateLimitDia(new Date(agora));
  const lista = limparFotoJogosRateLimit(readFotoJogosRateLimit(), agora, diaAtual);
  const index = lista.findIndex(entry => entry.id === reserva.id);
  if (index < 0) return;

  lista[index] = {
    ...lista[index],
    status: status === "success" ? "success" : "failed",
    atualizado_em: agora
  };
  writeFotoJogosRateLimit(lista);
}

const fotoJogosAnalysisDedupe = new Map();

function normalizarFotoJogosAnalysisRequestId(value) {
  return normalizarClientRequestId(value);
}

function hashFotoJogosAnalysisImage(imagem) {
  const conteudo = Buffer.isBuffer(imagem?.buffer)
    ? imagem.buffer
    : imagem?.path
      ? fs.readFileSync(imagem.path)
      : Buffer.alloc(0);
  return crypto
    .createHash("sha256")
    .update(conteudo)
    .digest("hex");
}

function buildFotoJogosAnalysisDedupeKey(req, requestId) {
  const normalizedRequestId = normalizarFotoJogosAnalysisRequestId(requestId);
  if (!normalizedRequestId) return "";
  const usuario = getFotoJogosUsuarioIdentificador(req);
  return hashFotoJogosRateLimit(`foto-jogos:analysis:${usuario}:${normalizedRequestId}`);
}

function cleanupFotoJogosAnalysisDedupe(now = Date.now()) {
  for (const [key, entry] of fotoJogosAnalysisDedupe.entries()) {
    if (!entry || entry.expiresAt <= now) fotoJogosAnalysisDedupe.delete(key);
  }
}

function getFotoJogosAnalysisDedupeEntry(key) {
  if (!key) return null;
  cleanupFotoJogosAnalysisDedupe();
  const entry = fotoJogosAnalysisDedupe.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    fotoJogosAnalysisDedupe.delete(key);
    return null;
  }
  return entry;
}

function beginFotoJogosAnalysisDedupe(key, imageHash, promise) {
  if (!key) return null;
  const entry = {
    imageHash,
    promise,
    expiresAt: Date.now() + FOTO_JOGOS_ANALYSIS_DEDUPE_TTL_MS
  };
  fotoJogosAnalysisDedupe.set(key, entry);
  promise.then(() => {
    const atual = fotoJogosAnalysisDedupe.get(key);
    if (atual === entry) atual.expiresAt = Date.now() + FOTO_JOGOS_ANALYSIS_DEDUPE_TTL_MS;
  }).catch(() => {
    const atual = fotoJogosAnalysisDedupe.get(key);
    if (atual === entry) fotoJogosAnalysisDedupe.delete(key);
  });
  return entry;
}

const FOTO_JOGOS_BATCH_MAX_ITEMS = 3;
const FOTO_JOGOS_BATCH_DEDUPE_TTL_MS = 2 * 60 * 1000;
const FOTO_JOGOS_BATCH_ALLOWED_FILE_KEYS = new Set(["escudo1", "escudo2", "mascote", "patrocinadores"]);
const FOTO_JOGOS_BATCH_FILE_FIELD_RE = /^item_(\d+)_(escudo1|escudo2|mascote|patrocinadores)$/;
const FOTO_JOGOS_BATCH_MAX_FILES = FOTO_JOGOS_BATCH_MAX_ITEMS * FOTO_JOGOS_BATCH_ALLOWED_FILE_KEYS.size;
const FOTO_JOGOS_BATCH_PRODUCTS = {
  proximo_jogo: { flyerTipo: "zz1ft", label: "Pr\u00f3ximo Jogo" },
  resultado: { flyerTipo: "", label: "Resultado" },
  escalacao: { flyerTipo: "zz1fs", label: "Escala\u00e7\u00e3o" },
  escudo3d: { flyerTipo: "escudo3d", label: "Escudo 3D" },
  jogador_escudo: { flyerTipo: "jog_escudo", label: "Jogador + Escudo" }
};
const LEGACY_GENERATION_CONTRACTS = Object.freeze({
  proximo_jogo: {
    route: "/pedidos",
    internalType: "proximo_jogo",
    flyerTipo: "zz1ft",
    promptFile: "prompt_proximo_jogo.txt",
    promptSha256: "52332d764971c58dbf076c6fd0bced4ad9267e1e1362fc6ae698170b59bd2605"
  },
  resultado: {
    route: "/resultado_do_jogo",
    internalType: "resultado",
    flyerTipo: "",
    promptFile: "prompt_resultado.txt",
    promptSha256: "1e2515909c00b7ba3d916f6fa54ee49bbf45780aca7b14a3a8fd7739569ff988"
  },
  escalacao: {
    route: "/pedidos",
    internalType: "escalacao",
    flyerTipo: "zz1fs",
    promptFile: "prompt_escalacao.txt",
    promptSha256: "b5064e67df90748f6538a106a5757e274da250c1183221747a86d5805fd0603d"
  },
  escudo3d: {
    route: "/pedidos",
    internalType: "escudo3d",
    flyerTipo: "escudo3d",
    promptFile: "prompt_escudo3d.txt",
    promptSha256: "3184668dc7a9db4154f3bb4d7435b19d32173514bc50fbe0824e1b36364db988"
  },
  jogador_escudo: {
    route: "/pedidos",
    internalType: "jogador_escudo",
    flyerTipo: "jog_escudo",
    promptFile: "prompt_jogador_escudo.txt",
    promptSha256: "80c1624d9741ea4ef73b237b90400ec647b78a421d6f8084d7d2f009aa33935c"
  },
  mascote_uniforme: {
    route: "/pedidos",
    internalType: "mascote_uniforme",
    flyerTipo: "mascote_uniforme",
    promptFile: "prompt_mascote_uniforme.txt",
    promptSha256: "a5d8712ca1abf7a8e15742d5074edefe4b1d0e414cddcde4992f8551587b5006"
  }
});
const fotoJogosBatchDedupe = new Map();

function normalizarFotoJogosBatchId(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w:.-]+/g, "_")
    .slice(0, 120);
}

function normalizarFotoJogosBatchProduto(value) {
  const produto = String(value || "").trim().toLowerCase();
  return FOTO_JOGOS_BATCH_PRODUCTS[produto] ? produto : "";
}

function parseFotoJogosBatchItems(body = {}) {
  const raw = body.items_json || body.itens_json || body.items || body.itens || [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getFotoJogosBatchFileMap(files) {
  const mapa = new Map();
  const lista = Array.isArray(files)
    ? files
    : Object.values(files || {}).flat();

  for (const file of lista) {
    if (!file?.fieldname) continue;
    if (!mapa.has(file.fieldname)) mapa.set(file.fieldname, []);
    mapa.get(file.fieldname).push(file);
  }

  return mapa;
}

function getFotoJogosBatchMappedFiles(fileMap, item) {
  const fileFields = item?.files && typeof item.files === "object" && !Array.isArray(item.files)
    ? item.files
    : {};
  const output = {};

  ["escudo1", "escudo2", "mascote", "patrocinadores"].forEach(legacyName => {
    const mapped = String(fileFields[legacyName] || "").trim();
    if (!mapped) return;
    const files = fileMap.get(mapped) || [];
    if (files.length) output[legacyName] = files;
  });

  return output;
}

function validarFotoJogosBatchFileBindings(files, items) {
  const lista = Array.isArray(files)
    ? files
    : Object.values(files || {}).flat();
  const erros = [];
  const camposDeclarados = new Map();
  const camposRecebidos = new Map();

  if (lista.length > FOTO_JOGOS_BATCH_MAX_FILES) {
    erros.push("Muitos arquivos no lote.");
  }

  items.forEach((rawItem, index) => {
    const item = rawItem && typeof rawItem === "object" && !Array.isArray(rawItem) ? rawItem : {};
    const fileFields = item.files && typeof item.files === "object" && !Array.isArray(item.files)
      ? item.files
      : {};

    for (const [rawKey, rawFieldName] of Object.entries(fileFields)) {
      const key = String(rawKey || "").trim();
      const fieldName = String(rawFieldName || "").trim();
      if (!fieldName) continue;

      if (!FOTO_JOGOS_BATCH_ALLOWED_FILE_KEYS.has(key)) {
        erros.push("Campo de arquivo inv\u00e1lido.");
        continue;
      }

      const esperado = `item_${index}_${key}`;
      if (fieldName !== esperado) {
        erros.push("Arquivo vinculado ao item incorreto.");
        continue;
      }

      camposDeclarados.set(fieldName, (camposDeclarados.get(fieldName) || 0) + 1);
    }
  });

  for (const file of lista) {
    const fieldName = String(file?.fieldname || "").trim();
    const match = fieldName.match(FOTO_JOGOS_BATCH_FILE_FIELD_RE);
    camposRecebidos.set(fieldName, (camposRecebidos.get(fieldName) || 0) + 1);

    if (!match) {
      erros.push("Campo de upload inv\u00e1lido.");
      continue;
    }

    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      erros.push("Arquivo enviado para item inexistente.");
      continue;
    }

    if (!camposDeclarados.has(fieldName)) {
      erros.push("Arquivo enviado sem v\u00ednculo com item.");
    }
  }

  for (const total of camposDeclarados.values()) {
    if (total > 1) erros.push("Arquivo declarado mais de uma vez.");
  }

  for (const total of camposRecebidos.values()) {
    if (total > 1) erros.push("Arquivo enviado mais de uma vez.");
  }

  return {
    ok: erros.length === 0,
    errors: [...new Set(erros)]
  };
}

function fotoJogosBatchFalha(index, item, error) {
  return {
    index,
    product_id: item?.product_id || item?.productKey || item?.produto || "",
    client_request_id: normalizarClientRequestId(item?.client_request_id || ""),
    error: error || "Item inv\u00e1lido."
  };
}

function fotoJogosBatchTemTexto(value) {
  return String(value ?? "").trim().length > 0;
}

function fotoJogosBatchTemPlacar(value) {
  if (value === null || value === undefined || value === "") return false;
  const numero = Number(value);
  return Number.isFinite(numero) && numero >= 0;
}

function fotoJogosBatchParseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validarFotoJogosBatchItem({ productId, body, files }) {
  const erros = [];
  const temArquivo = field => Array.isArray(files?.[field]) && files[field].length > 0;

  if (!productId) erros.push("Produto inv\u00e1lido.");

  if (["proximo_jogo", "resultado", "escalacao"].includes(productId)) {
    if (!fotoJogosBatchTemTexto(body.time_principal) || !fotoJogosBatchTemTexto(body.time_adversario)) {
      erros.push("Informe os dois times.");
    }
  }

  if (productId === "proximo_jogo") {
    if (!fotoJogosBatchTemTexto(body.data)) erros.push("Informe data e hor\u00e1rio.");
    if (!fotoJogosBatchTemTexto(body.hora)) erros.push("Informe campeonato ou competi\u00e7\u00e3o.");
    if (!temArquivo("escudo1") || !temArquivo("escudo2")) erros.push("Adicione os escudos dos dois times.");
  }

  if (productId === "resultado") {
    if (!fotoJogosBatchTemPlacar(body.gols_time_principal) || !fotoJogosBatchTemPlacar(body.gols_adversario)) {
      erros.push("Informe o placar.");
    }
    if (!fotoJogosBatchTemTexto(body.hora)) erros.push("Informe campeonato ou competi\u00e7\u00e3o.");
    if (!temArquivo("escudo1")) erros.push("Adicione o escudo do Time A.");
  }

  if (productId === "escalacao") {
    const jogadores = fotoJogosBatchParseJsonArray(body.jogadores_json);
    const jogadoresValidos = jogadores.filter(jogador => fotoJogosBatchTemTexto(jogador?.nome));
    if (!fotoJogosBatchTemTexto(body.rodada)) erros.push("Informe o confronto.");
    if (jogadoresValidos.length < 1 && !fotoJogosBatchTemTexto(body.jogadores_texto)) {
      erros.push("Informe jogadores ou escala\u00e7\u00e3o.");
    }
  }

  if (productId === "escudo3d") {
    if (!temArquivo("escudo1")) erros.push("Adicione o escudo do time.");
  }

  if (productId === "jogador_escudo") {
    if (!fotoJogosBatchTemTexto(body.data)) erros.push("Informe o nome do jogador.");
    if (!temArquivo("escudo1")) erros.push("Adicione o escudo do time.");
    if (!temArquivo("mascote")) erros.push("Adicione a foto do jogador.");
    if (String(body.foto_tipo || "").trim() && String(body.foto_tipo || "").trim() !== "jogador") {
      erros.push("Use uma foto marcada como Foto de jogador.");
    }
  }

  if (!orderService.hasRequiredOrderFields(orderService.normalizeOrderBody(body))) {
    erros.push("Pedido incompleto.");
  }

  return {
    ok: erros.length === 0,
    errors: [...new Set(erros)]
  };
}

function normalizarFotoJogosBatchItem(rawItem, index, batchId, fileMap) {
  const item = rawItem && typeof rawItem === "object" && !Array.isArray(rawItem) ? rawItem : {};
  const productId = normalizarFotoJogosBatchProduto(item.product_id || item.productKey || item.produto);
  const productInfo = FOTO_JOGOS_BATCH_PRODUCTS[productId] || {};
  const clientRequestId = normalizarClientRequestId(item.client_request_id || `${batchId}_item_${index + 1}`);
  const fields = item.fields && typeof item.fields === "object" && !Array.isArray(item.fields)
    ? item.fields
    : {};
  const modalidadeCriacaoInformada = String(item.modalidade_criacao || "").trim().toLowerCase();
  const modalidadeCriacao = normalizarModalidadeCriacao(modalidadeCriacaoInformada);
  const body = {
    ...fields,
    flyer_tipo: fields.flyer_tipo || productInfo.flyerTipo || "",
    client_request_id: clientRequestId,
    modalidade_criacao: modalidadeCriacao,
    batch_id: batchId,
    assistente_lote: true
  };
  const files = getFotoJogosBatchMappedFiles(fileMap, item);

  return {
    index,
    productId,
    productLabel: productInfo.label || productId,
    clientRequestId,
    modalidadeCriacao,
    modalidadeCriacaoValida: !modalidadeCriacaoInformada || MODALIDADES_CRIACAO.has(modalidadeCriacaoInformada),
    body,
    files
  };
}

function cleanupFotoJogosBatchDedupe(now = Date.now()) {
  for (const [key, entry] of fotoJogosBatchDedupe.entries()) {
    if (!entry || entry.expiresAt <= now) fotoJogosBatchDedupe.delete(key);
  }
}

function getFotoJogosBatchDedupeEntry(key) {
  cleanupFotoJogosBatchDedupe();
  const entry = fotoJogosBatchDedupe.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    fotoJogosBatchDedupe.delete(key);
    return null;
  }
  return entry;
}

function buildFotoJogosBatchPayloadHash(req, batchId, items) {
  const fileMap = getFotoJogosBatchFileMap(req.files || []);
  const normalizedItems = items.map((item, index) =>
    normalizarFotoJogosBatchItem(item, index, batchId, fileMap)
  );
  const canonicalItems = normalizedItems.map(item => {
    let canonicalFields;

    try {
      const context = buildOrderScenarioContext(item.productId, item.body);
      canonicalFields = getSemanticOrderFields(context.fields);
    } catch (error) {
      canonicalFields = {
        scenario_validation_error: error?.code || "SCENARIO_INVALID",
        raw: item.body
      };
    }

    return {
      index: item.index,
      product_id: item.productId,
      client_request_id: item.clientRequestId,
      modalidade_criacao: item.modalidadeCriacao,
      cupom_codigo: normalizarCupomCodigo(item.body?.cupom_codigo),
      fields: canonicalFields,
      files: getUploadedFilesFingerprint(item.files)
    };
  });

  return crypto
    .createHash("sha256")
    .update(stableOrderJson({
      user: String(req.user?.whatsapp || ""),
      batch_id: batchId,
      items: canonicalItems
    }))
    .digest("hex");
}

function beginFotoJogosBatchDedupe(key, payloadHash, promise) {
  const entry = {
    payloadHash: String(payloadHash || ""),
    promise,
    expiresAt: Date.now() + FOTO_JOGOS_BATCH_DEDUPE_TTL_MS
  };
  fotoJogosBatchDedupe.set(key, entry);
  promise.finally(() => {
    const atual = fotoJogosBatchDedupe.get(key);
    if (atual === entry) atual.expiresAt = Date.now() + FOTO_JOGOS_BATCH_DEDUPE_TTL_MS;
  }).catch(() => {});
  return entry;
}

function buildFotoJogosBatchSubRequest(req, item) {
  const headers = {
    ...(req.headers || {}),
    "x-idempotency-key": item.clientRequestId
  };

  return {
    ...req,
    method: req.method,
    originalUrl: "/me/time/jogos/criar-artes",
    url: "/me/time/jogos/criar-artes",
    headers,
    user: req.user,
    fotoJogosBatchItem: true,
    body: item.body,
    files: item.files,
    file: undefined,
    get(name) {
      return headers[String(name || "").toLowerCase()] || headers[name] || "";
    }
  };
}

function criarPedidoFotoJogosBatch(req, item) {
  return new Promise(resolve => {
    const subReq = buildFotoJogosBatchSubRequest(req, item);
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) {
        this.statusCode = Number(code || 200);
        return this;
      },
      json(payload) {
        resolve({
          status: this.statusCode || 200,
          payload: payload || {}
        });
      }
    };

    try {
      criarPedidoHandler(item.productId)(subReq, res);
    } catch (err) {
      resolve({
        status: Number(err?.status || 500),
        payload: {
          ok: false,
          error: err?.message || "Falha ao criar pedido."
        }
      });
    }
  });
}

async function processarFotoJogosCriarArtesBatch(req, batchId, items) {
  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();
  const cliente = clientes[whatsapp];
  const fileMap = getFotoJogosBatchFileMap(req.files || []);
  const falhas = [];
  const criados = [];

  if (!cliente || !cliente.ativo) {
    return {
      status: 403,
      payload: { ok: false, batch_id: batchId, criados, falhas: [{ index: -1, error: "Mensalidade inativa." }] }
    };
  }

  const normalizados = items.map((item, index) => normalizarFotoJogosBatchItem(item, index, batchId, fileMap));
  const validos = [];
  const mesAtual = nowYYYYMM();
  billingService.ensureCurrentBillingCycle(cliente, mesAtual);

  for (const item of normalizados) {
    if (!item.modalidadeCriacaoValida) {
      falhas.push({
        index: item.index,
        product_id: item.productId,
        client_request_id: item.clientRequestId,
        error: "Modalidade de cria\u00e7\u00e3o inv\u00e1lida."
      });
      continue;
    }

    const validacao = validarFotoJogosBatchItem(item);
    if (!validacao.ok) {
      falhas.push({
        index: item.index,
        product_id: item.productId,
        client_request_id: item.clientRequestId,
        error: validacao.errors[0] || "Item inv\u00e1lido.",
        detalhes: validacao.errors
      });
      continue;
    }

    validos.push(item);
  }

  if (!validos.length) {
    limparUploadsRequest(req);
    return {
      status: criados.length ? 200 : 400,
      payload: { ok: criados.length > 0, batch_id: batchId, criados, falhas }
    };
  }

  for (const item of validos) {
    const resposta = await criarPedidoFotoJogosBatch(req, item);
    const payload = resposta.payload || {};

    if (payload.ok && payload.pedido_id) {
      criados.push({
        ...payload,
        index: item.index,
        product_id: item.productId
      });
    } else {
      falhas.push({
        index: item.index,
        product_id: item.productId,
        client_request_id: item.clientRequestId,
        status: resposta.status,
        code: payload.code || "",
        scenario_id: payload.scenario_id || "",
        error: payload.error || payload.mensagem || payload.erro || "Falha ao criar arte."
      });
    }
  }

  limparUploadsRequest(req);
  return {
    status: criados.length ? 200 : Number(falhas[0]?.status || 400),
    payload: {
      ok: criados.length > 0,
      batch_id: batchId,
      criados,
      falhas
    }
  };
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

function getOrderRequestLogContext(req, extra = {}) {
  return {
    evento: extra.evento || "pedido",
    etapa: extra.etapa || "",
    data_hora: new Date().toISOString(),
    metodo: req.method,
    endpoint: req.originalUrl || req.url || "",
    user_agent: req.headers["user-agent"] || "",
    origin: req.headers.origin || "",
    referer: req.headers.referer || "",
    client_request_id: extra.client_request_id || "",
    pedido_id: extra.pedido_id || "",
    categoria: extra.categoria || "",
    status_code: extra.status_code || "",
    idempotent_replay: extra.idempotent_replay === true,
    scenario_id: extra.scenario_id || "",
    scenario_version: Number(extra.scenario_version || 0) || 0,
    scenario_source: extra.scenario_source || "",
    idempotency_payload_hash: extra.idempotency_payload_hash || "",
    idempotency_payload_hash_version: Number(extra.idempotency_payload_hash_version || 0) || 0,
    detalhe: extra.detalhe || ""
  };
}

function logOrderRequestEvent(req, etapa, extra = {}) {
  try {
    console.log("[pedido_fluxo]", JSON.stringify(getOrderRequestLogContext(req, {
      ...extra,
      etapa
    })));
  } catch (e) {
    console.warn("[pedido_fluxo] falha ao registrar log", e.message);
  }
}

function normalizarClientRequestId(value) {
  return String(value || "").trim().slice(0, 180);
}

function buildOrderScenarioContext(categoria, body = {}) {
  const legacyFields = orderService.normalizeOrderBody(body);
  const fields = orderService.normalizeOrderBody(body);
  const resolution = resultScenarioRegistry.resolveProductScenario({
    categoria,
    body
  });

  resultScenarioRegistry.applyProductScenario(fields, resolution);

  const observationConflict = resultScenarioRegistry.getScenarioObservationConflict(
    fields,
    resolution
  );

  if (observationConflict) {
    throw resultScenarioRegistry.scenarioError(
      "SCENARIO_OBSERVATION_CONFLICT",
      "A observacao nao pode pedir a troca de fundo ou cenario controlado pelo pedido.",
      422,
      {
        scenario_id: resolution.scenario?.id || "",
        scenario_version: Number(resolution.scenario?.version || 0) || 0,
        scenario_source: resolution.source || "",
        conflict_field: observationConflict.field
      }
    );
  }

  return {
    fields,
    legacyFields,
    resolution
  };
}

function scenarioErrorPayload(error) {
  const details = error?.details && typeof error.details === "object"
    ? error.details
    : {};

  return {
    ok: false,
    code: error?.code || "SCENARIO_INVALID",
    error: error?.message || "Cenario invalido.",
    ...(details.scenario_id ? { scenario_id: details.scenario_id } : {}),
    ...(Number(details.scenario_version || 0) > 0
      ? { scenario_version: Number(details.scenario_version) }
      : {}),
    ...(details.scenario_source ? { scenario_source: details.scenario_source } : {}),
    ...(details.scenario_status ? { scenario_status: details.scenario_status } : {})
  };
}

function getScenarioLogMeta(resolution) {
  if (!resolution?.applies || !resolution.scenario) {
    return {
      scenario_id: "",
      scenario_version: 0,
      scenario_source: ""
    };
  }

  return {
    scenario_id: resolution.scenario.id,
    scenario_version: resolution.scenario.version,
    scenario_source: resolution.source
  };
}

function buildOrderResponsePayloadFromItem(item, extra = {}) {
  const pedido = item?.pedido || {};
  const pedidoId = pedido.id || item?.id || "";
  const scenarioMeta = resultScenarioRegistry.getPedidoScenarioMeta(pedido);
  const descontoInfo = pedido.desconto_info || null;
  const valorPago = Number(pedido.pagamento_info?.valor_pago || 0);
  const modalidadeCriacao = normalizarModalidadeCriacao(pedido.modalidade_criacao);
  const valorProduto = calcularCustoPedidoPorModalidade(
    getCustoPedido(pedido.categoria || pedido.product_id || "", null),
    modalidadeCriacao
  );
  const valorOriginal = Number(pedido.valor_original || valorProduto || 0);

  return {
    ok: true,
    pedido_id: pedidoId,
    client_request_id: pedido.client_request_id || "",
    pagamento_pendente: pedido.pagamento_pendente === true,
    valor_pendente: Number(pedido.valor_pendente || 0),
    cupom_aplicado: pedido.cupom_aplicado === true,
    desconto: descontoInfo,
    valor_original: valorOriginal,
    valor_desconto: Number(pedido.valor_desconto || 0),
    valor_final: Number(pedido.valor_final || pedido.valor_pendente || valorPago || valorOriginal || 0),
    modalidade_criacao: modalidadeCriacao,
    suporte_personalizado_incluido: modalidadeCriacao !== MODALIDADE_CRIACAO_ECONOMICA,
    status: pedido.status || "",
    criado_em: pedido.criado_em || item?.criado_em || "",
    ...scenarioMeta,
    ...extra
  };
}

function readSaldoTransacoes() {
  return readJsonArraySafe(SALDO_TRANSACOES_FILE);
}

function writeSaldoTransacoes(lista) {
  writeJsonSafe(SALDO_TRANSACOES_FILE, Array.isArray(lista) ? lista : []);
}

function getClienteUserId(cliente, whatsapp) {
  return String(cliente?.cliente_id || cliente?.id || whatsapp || "").trim();
}

function findSaldoDebitTransaction(userId, clientRequestId, valor) {
  const wantedUser = String(userId || "").trim();
  const wantedRequest = normalizarClientRequestId(clientRequestId);
  const wantedValor = Number(Number(valor || 0).toFixed(2));

  if (!wantedUser || !wantedRequest || wantedValor <= 0) return null;

  return readSaldoTransacoes().find(tx =>
    tx &&
    tx.tipo === "saldo_ia4tube" &&
    String(tx.user_id || "").trim() === wantedUser &&
    String(tx.client_request_id || "").trim() === wantedRequest &&
    Math.abs(Number(tx.valor || 0) - wantedValor) < 0.01
  ) || null;
}

function appendSaldoTransaction(tx) {
  const lista = readSaldoTransacoes();
  lista.push(tx);
  writeSaldoTransacoes(lista);
  return tx;
}

function aplicarCobrancaPedidoComLedger({ cliente, whatsapp, pedidoId, clientRequestId, custoPedido, mesAtual, temBrindeMascote }) {
  const valor = Number(Number(custoPedido || 0).toFixed(2));
  const userId = getClienteUserId(cliente, whatsapp);
  const existente = findSaldoDebitTransaction(userId, clientRequestId, valor);

  if (existente) {
    return {
      reused: true,
      transacao: existente
    };
  }

  const saldoAntes = billingService.getBalanceFields(cliente);
  billingService.applyOrderCharge(cliente, { custoPedido: valor, mesAtual, temBrindeMascote });
  const saldoDepois = billingService.getBalanceFields(cliente);

  if (valor <= 0 || !clientRequestId) {
    return {
      reused: false,
      transacao: null,
      saldo_antes: saldoAntes,
      saldo_depois: saldoDepois
    };
  }

  const transacao = appendSaldoTransaction({
    id: `saldo_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    tipo: "saldo_ia4tube",
    user_id: userId,
    whatsapp,
    client_request_id: normalizarClientRequestId(clientRequestId),
    pedido_id: pedidoId,
    valor,
    data_hora: new Date().toISOString(),
    saldo_antes: saldoAntes,
    saldo_depois: saldoDepois
  });

  return {
    reused: false,
    transacao,
    saldo_antes: saldoAntes,
    saldo_depois: saldoDepois
  };
}

function normalizarPerfilId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "");
}

function normalizarPerfilSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function gerarPerfilSlug(nomeTime, perfilId) {
  const base = normalizarPerfilSlug(nomeTime || "time") || "time";
  const sufixo = normalizarPerfilId(perfilId).replace(/^pf_/, "").slice(0, 6) || crypto.randomBytes(3).toString("hex");
  const baseCurta = base.slice(0, 58).replace(/-+$/g, "") || "time";
  return `${baseCurta}-${sufixo}`;
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

function getPerfilAssetsDir(perfilId) {
  return path.join(getPerfilDir(perfilId), "assets");
}

function getPerfilJogadoresFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "jogadores.json");
}

function getPerfilJogosFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "jogos.json");
}

function getPerfilEscalacaoFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "escalacao.json");
}

function getPerfilDivisoesFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "divisoes.json");
}

function getPerfilAvaliacoesJogadoresFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "avaliacoes-jogadores.json");
}

function getPerfilPatrocinadoresFile(perfilId) {
  return path.join(getPerfilDir(perfilId), "patrocinadores.json");
}

function getPerfilPatrocinadoresAssetsDir(perfilId) {
  return path.join(getPerfilAssetsDir(perfilId), "patrocinadores");
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
  const nomeTime = textoPerfil(cliente?.nome_time || "Meu time");

  return {
    perfil_id: perfilId,
    slug: gerarPerfilSlug(nomeTime, perfilId),
    nome_time: nomeTime,
    cidade: "",
    estado: "",
    instagram: "",
    escudo_url: "",
    escudo_path: "",
    mascote_url: "",
    mascote_path: "",
    descricao_curta: "",
    titulo_secao_resultados: "",
    titulo_secao_proximo_jogo: "",
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
  const nomeTime = textoPerfil(base.nome_time || cliente?.nome_time || "Meu time");
  const slug = normalizarPerfilSlug(base.slug) || gerarPerfilSlug(nomeTime, perfilId);

  return {
    perfil_id: perfilId,
    slug,
    nome_time: nomeTime,
    cidade: textoPerfil(base.cidade || ""),
    estado: textoPerfil(base.estado || "", 40),
    instagram: normalizarInstagramPerfil(base.instagram || ""),
    escudo_url: assetPerfil(base.escudo_url || ""),
    escudo_path: assetPerfil(base.escudo_path || ""),
    mascote_url: assetPerfil(base.mascote_url || ""),
    mascote_path: assetPerfil(base.mascote_path || ""),
    descricao_curta: textoPerfil(base.descricao_curta || "", 240),
    titulo_secao_resultados: textoPerfil(base.titulo_secao_resultados || "", 80),
    titulo_secao_proximo_jogo: textoPerfil(base.titulo_secao_proximo_jogo || "", 80),
    publico: base.publico === true,
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
    slug: perfil.slug,
    nome_time: perfil.nome_time,
    cidade: perfil.cidade,
    estado: perfil.estado,
    instagram: perfil.instagram,
    escudo_url: perfil.escudo_url || "",
    escudo_path: perfil.escudo_path || "",
    mascote_url: perfil.mascote_url || "",
    mascote_path: perfil.mascote_path || "",
    descricao_curta: perfil.descricao_curta || "",
    titulo_secao_resultados: perfil.titulo_secao_resultados || "",
    titulo_secao_proximo_jogo: perfil.titulo_secao_proximo_jogo || "",
    publico: perfil.publico === true,
    public_url: perfil.publico === true && perfil.slug ? `/app.html?time=${encodeURIComponent(perfil.slug)}` : "",
    criado_em: perfil.criado_em,
    atualizado_em: perfil.atualizado_em
  };
}

function perfilPublicoResumoPorId(perfilId) {
  const perfilIdNormalizado = normalizarPerfilId(perfilId);
  if (!perfilIdNormalizado) return null;

  const perfilAtual = safeReadJson(getPerfilFile(perfilIdNormalizado));
  if (!perfilAtual) return null;

  const perfil = normalizarPerfilPrivado(perfilAtual, { nome_time: perfilAtual.nome_time }, perfilIdNormalizado);
  const publico = perfil.publico === true && !!perfil.slug;
  const publicUrl = publico ? `/app.html?time=${encodeURIComponent(perfil.slug)}` : "";

  return {
    nome_time: perfil.nome_time,
    slug: publico ? perfil.slug : "",
    publico,
    public_url: publicUrl
  };
}

const PERFIL_IMAGEM_TIPOS = new Set(["escudo", "mascote"]);
const IMAGEM_UPLOAD_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function normalizarMimeImagem(mimetype) {
  const tipo = String(mimetype || "").toLowerCase();
  return tipo === "image/jpg" ? "image/jpeg" : tipo;
}

function getExtensaoImagemSegura(mimetype) {
  const tipo = normalizarMimeImagem(mimetype);
  if (tipo === "image/png") return ".png";
  if (tipo === "image/jpeg") return ".jpg";
  if (tipo === "image/webp") return ".webp";
  return "";
}

function getExtensaoImagemPerfil(mimetype) {
  return getExtensaoImagemSegura(mimetype);
}

function detectarImagemArquivo(filePath) {
  let fd = null;

  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);

    if (!header.length) return null;

    if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { mime: "image/png", ext: ".png" };
    }

    if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return { mime: "image/jpeg", ext: ".jpg" };
    }

    if (
      header.length >= 12 &&
      header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return { mime: "image/webp", ext: ".webp" };
    }
  } catch {
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  return null;
}

function detectarImagemPerfilArquivo(filePath) {
  return detectarImagemArquivo(filePath);
}

function validarAssinaturaImagem(file) {
  if (!file?.path) {
    return { ok: false, error: "Arquivo de imagem nao enviado." };
  }

  if (Number(file.size || 0) <= 0) {
    return { ok: false, error: "Arquivo vazio. Envie uma imagem PNG, JPG ou WEBP." };
  }

  const mimeDeclarado = String(file?.mimetype || "").toLowerCase();
  if (!IMAGEM_UPLOAD_MIMES.has(mimeDeclarado)) {
    return { ok: false, error: "Formato de imagem invalido. Envie PNG, JPG ou WEBP." };
  }

  const detectada = detectarImagemArquivo(file.path);
  if (!detectada) {
    return { ok: false, error: "Arquivo de imagem invalido. Envie PNG, JPG ou WEBP." };
  }

  const mimeNormalizado = normalizarMimeImagem(mimeDeclarado);

  if (mimeNormalizado && mimeNormalizado !== detectada.mime) {
    return { ok: false, error: "Arquivo de imagem invalido. O tipo declarado nao combina com o arquivo enviado." };
  }

  return { ok: true, ...detectada };
}

function validarAssinaturaImagemPerfil(file) {
  return validarAssinaturaImagem(file);
}

const FOTO_JOGOS_OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5-mini";
const FOTO_JOGOS_OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_VISION_TIMEOUT_MS || 120000);
const FOTO_JOGOS_OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS || 6000);
const FOTO_JOGOS_OPENAI_REASONING_EFFORT = process.env.OPENAI_VISION_REASONING_EFFORT || "low";
const FOTO_JOGOS_MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const FOTO_JOGOS_OBSERVACAO_MAX = 1200;
const FOTO_JOGOS_OBSERVACAO_RESUMO = "\n[Conte\u00fado resumido para caber no limite de 1.200 caracteres.]";
const FOTO_JOGOS_CAMPOS = [
  "time_a",
  "time_b",
  "resultado_gols_a",
  "resultado_gols_b",
  "data",
  "horario",
  "competicao",
  "rodada",
  "fase",
  "local",
  "numero_jogo",
  "categoria",
  "grupo",
  "observacao"
];
const FOTO_JOGOS_ESTRUTURADOS = [
  "status",
  "placar_tempo_normal",
  "placar_final",
  "disputa_penaltis",
  "cidade",
  "estadio_ginasio",
  "modalidade",
  "genero",
  "classificacao",
  "patrocinadores",
  "organizador",
  "transmissao"
];

const FOTO_JOGOS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jogos"],
  properties: {
    jogos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [...FOTO_JOGOS_CAMPOS, ...FOTO_JOGOS_ESTRUTURADOS, "events", "additional_information"],
        properties: {
          ...[...FOTO_JOGOS_CAMPOS, ...FOTO_JOGOS_ESTRUTURADOS].reduce((acc, campo) => {
            acc[campo] = { type: "string" };
            return acc;
          }, {}),
          events: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "team", "player", "minute", "details"],
              properties: {
                type: { type: "string" },
                team: { type: "string" },
                player: { type: "string" },
                minute: { type: "string" },
                details: { type: "string" }
              }
            }
          },
          additional_information: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  }
};

function normalizarTextoFotoJogo(value, max = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizarObservacaoFotoJogo(value) {
  const texto = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(linha => linha.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (texto.length <= FOTO_JOGOS_OBSERVACAO_MAX) return texto;

  const limite = FOTO_JOGOS_OBSERVACAO_MAX - FOTO_JOGOS_OBSERVACAO_RESUMO.length;
  let base = texto.slice(0, Math.max(0, limite)).trimEnd();
  const ultimoEspaco = Math.max(base.lastIndexOf(" "), base.lastIndexOf("\n"));
  if (ultimoEspaco >= Math.floor(limite * 0.75)) {
    base = base.slice(0, ultimoEspaco).trimEnd();
  }
  return `${base}${FOTO_JOGOS_OBSERVACAO_RESUMO}`;
}

function normalizarEventoFotoJogo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evento = {
    type: normalizarTextoFotoJogo(value.type, 40),
    team: normalizarTextoFotoJogo(value.team, 80),
    player: normalizarTextoFotoJogo(value.player, 120),
    minute: normalizarTextoFotoJogo(value.minute, 20),
    details: normalizarTextoFotoJogo(value.details, 160)
  };
  return Object.values(evento).some(Boolean) ? evento : null;
}

function formatarInformacoesEsportivasFotoJogo(item, jogo) {
  const blocos = [];
  const adicionarBloco = (titulo, valores, linhaEmBrancoAposTitulo = false) => {
    const lista = (Array.isArray(valores) ? valores : [valores])
      .map(value => String(value || "").trim());
    if (!lista.some(Boolean)) return;
    blocos.push([`${titulo}:`, ...(linhaEmBrancoAposTitulo ? [""] : []), ...lista].join("\n"));
  };
  const formatarEvento = evento => {
    const autor = evento.player || evento.team || normalizarTextoFotoJogo(evento.type, 40);
    const minuto = evento.minute ? ` — ${evento.minute}` : "";
    const detalhe = evento.details ? ` (${evento.details})` : "";
    return `• ${autor}${minuto}${detalhe}`;
  };
  const agruparEventosPorTime = eventosLista => {
    const grupos = [];
    const porTime = new Map();
    for (const evento of eventosLista) {
      const time = evento.team || "Time não identificado";
      const chave = normalizarTextoChaveFotoJogo(time) || time;
      if (!porTime.has(chave)) {
        const grupo = { time, eventos: [] };
        porTime.set(chave, grupo);
        grupos.push(grupo);
      }
      porTime.get(chave).eventos.push(evento);
    }
    return grupos.flatMap((grupo, index) => [
      ...(index ? [""] : []),
      grupo.time,
      ...grupo.eventos.map(formatarEvento)
    ]);
  };
  const eventos = (Array.isArray(item.events) ? item.events : [])
    .map(normalizarEventoFotoJogo)
    .filter(Boolean);
  const tipoEvento = evento => normalizarTextoChaveFotoJogo(evento.type);
  const gols = eventos.filter(evento => ["goal", "gol"].includes(tipoEvento(evento)));
  const expulsoes = eventos.filter(evento => /\b(red card|expulsion|expulsao|cartao vermelho)\b/.test(tipoEvento(evento)));
  const cartoes = eventos.filter(evento =>
    !expulsoes.includes(evento) &&
    /\b(yellow card|card|cartao amarelo|cartao)\b/.test(tipoEvento(evento))
  );
  const confronto = jogo.time_a && jogo.time_b
    ? `${jogo.time_a}${jogo.resultado_gols_a && jogo.resultado_gols_b ? ` ${jogo.resultado_gols_a} x ${jogo.resultado_gols_b} ` : " x "}${jogo.time_b}`
    : "";

  adicionarBloco("Competição", jogo.competicao);
  adicionarBloco("Resultado", confronto);
  adicionarBloco("Situação", normalizarTextoFotoJogo(item.status, 80));
  adicionarBloco("Autores dos gols", agruparEventosPorTime(gols), true);
  adicionarBloco("Cartões", agruparEventosPorTime(cartoes), true);
  adicionarBloco("Expulsões", agruparEventosPorTime(expulsoes), true);
  adicionarBloco("Disputa por pênaltis", normalizarTextoFotoJogo(item.disputa_penaltis, 100));

  const local = [
    normalizarTextoFotoJogo(item.estadio_ginasio, 120),
    normalizarTextoFotoJogo(jogo.local, 120),
    normalizarTextoFotoJogo(item.cidade, 80)
  ].filter((value, index, lista) => value && lista.findIndex(outro => normalizarTextoChaveFotoJogo(outro) === normalizarTextoChaveFotoJogo(value)) === index);
  adicionarBloco("Local", local.join(" — "));
  adicionarBloco("Data", normalizarTextoFotoJogo(jogo.data, 40));
  adicionarBloco("Horário", normalizarTextoFotoJogo(jogo.horario, 40));
  adicionarBloco("Fase", normalizarTextoFotoJogo(jogo.fase, 80));
  adicionarBloco("Rodada", normalizarTextoFotoJogo(jogo.rodada, 80));
  adicionarBloco("Categoria", normalizarTextoFotoJogo(jogo.categoria || item.genero, 80));
  adicionarBloco("Classificação", normalizarTextoFotoJogo(item.classificacao, 160));
  adicionarBloco("Patrocinadores", normalizarTextoFotoJogo(item.patrocinadores, 180));
  adicionarBloco("Organizador", normalizarTextoFotoJogo(item.organizador, 120));
  adicionarBloco("Transmissão", normalizarTextoFotoJogo(item.transmissao, 120));

  const confirmar = [
    ...(Array.isArray(item.additional_information) ? item.additional_information : []),
    normalizarValorCampoFotoJogo(item.observacao)
  ]
    .map(value => normalizarTextoFotoJogo(value, 180))
    .filter(value => /\b(possivel|confirmar|incerto|incerta|ilegivel|parcialmente legivel)\b/.test(normalizarTextoChaveFotoJogo(value)))
    .filter(value => !/\b(imagem|texto visivel|foi identificado|icone|indicador|indicacao|placar extra|tempo placar extra|ocr)\b/.test(normalizarTextoChaveFotoJogo(value)))
    .map(value => `• ${value.replace(/^(confirmar\s*:?\s*)/i, "")}`);
  adicionarBloco("Confirmar", confirmar);

  return normalizarObservacaoFotoJogo(blocos.join("\n\n"));
}

function normalizarValorCampoFotoJogo(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function normalizarTextoChaveFotoJogo(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function ehRotuloNaoTimeFotoJogo(value) {
  const texto = normalizarTextoChaveFotoJogo(value);
  if (!texto) return true;

  const genericosExatos = new Set([
    "campeonato",
    "competicao",
    "torneio",
    "copa",
    "liga",
    "rodada",
    "fase",
    "grupo",
    "chave",
    "categoria",
    "classificacao",
    "patrocinador",
    "patrocinadores",
    "apoio",
    "realizacao",
    "organizacao",
    "organizador",
    "prefeitura",
    "secretaria"
  ]);

  if (genericosExatos.has(texto)) return true;
  if (/\b(patrocinador|patrocinadores|realizacao|organizacao|organizador|apoio|prefeitura|secretaria)\b/.test(texto)) return true;

  const partes = texto.split(/\s+/).filter(Boolean);
  if (partes.length <= 3 && /^(campeonato|competicao|torneio|copa|liga|rodada|fase|grupo|chave|categoria|classificacao)\b/.test(texto)) {
    return true;
  }

  return false;
}

function normalizarRespostaJogosFoto(payload) {
  const lista = extrairListaJogosFoto(payload);
  const vistos = new Set();
  const jogos = [];

  for (const item of lista) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const jogo = {
      time_a: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.time_a), 80),
      time_b: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.time_b), 80),
      resultado_gols_a: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.resultado_gols_a), 3),
      resultado_gols_b: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.resultado_gols_b), 3),
      data: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.data), 40),
      horario: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.horario), 40),
      competicao: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.competicao), 120),
      rodada: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.rodada), 80),
      fase: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.fase), 80),
      local: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.local), 120),
      numero_jogo: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.numero_jogo), 40),
      categoria: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.categoria), 80),
      grupo: normalizarTextoFotoJogo(normalizarValorCampoFotoJogo(item.grupo), 80),
      observacao: ""
    };
    jogo.observacao = formatarInformacoesEsportivasFotoJogo(item, jogo);

    const timeAKey = normalizarTextoChaveFotoJogo(jogo.time_a);
    const timeBKey = normalizarTextoChaveFotoJogo(jogo.time_b);
    if (!timeAKey || !timeBKey || timeAKey === timeBKey) continue;
    if (ehRotuloNaoTimeFotoJogo(jogo.time_a) || ehRotuloNaoTimeFotoJogo(jogo.time_b)) continue;

    const parTimes = [timeAKey, timeBKey].sort().join(" x ");
    const chave = [
      parTimes,
      normalizarTextoChaveFotoJogo(jogo.data),
      normalizarTextoChaveFotoJogo(jogo.horario),
      normalizarTextoChaveFotoJogo(jogo.competicao),
      normalizarTextoChaveFotoJogo(jogo.rodada),
      normalizarTextoChaveFotoJogo(jogo.fase),
      normalizarTextoChaveFotoJogo(jogo.local),
      normalizarTextoChaveFotoJogo(jogo.numero_jogo),
      normalizarTextoChaveFotoJogo(jogo.categoria),
      normalizarTextoChaveFotoJogo(jogo.grupo)
    ].join("|");

    if (vistos.has(chave)) continue;
    vistos.add(chave);
    jogos.push(jogo);
    if (jogos.length >= 40) break;
  }

  return jogos;
}

function extrairListaJogosFoto(payload, depth = 0) {
  if (depth > 4 || payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  if (Array.isArray(payload.jogos)) return payload.jogos;

  for (const key of ["data", "resultado", "result", "output", "conteudo", "content"]) {
    const lista = extrairListaJogosFoto(payload[key], depth + 1);
    if (lista.length) return lista;
  }

  for (const value of Object.values(payload)) {
    const lista = extrairListaJogosFoto(value, depth + 1);
    if (lista.length) return lista;
  }

  return [];
}

function diagnosticarPayloadJogosFoto(payload) {
  const lista = extrairListaJogosFoto(payload);
  const camposInvalidos = new Set();
  let itensInvalidos = 0;

  for (const item of lista) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      itensInvalidos += 1;
      continue;
    }

    for (const campo of [...FOTO_JOGOS_CAMPOS, ...FOTO_JOGOS_ESTRUTURADOS]) {
      const value = item[campo];
      if (value === null || value === undefined) {
        camposInvalidos.add(campo + ":ausente_ou_null");
      } else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && typeof value !== "bigint") {
        camposInvalidos.add(campo + ":tipo_" + (Array.isArray(value) ? "array" : typeof value));
      }
    }
    if (!Array.isArray(item.events)) camposInvalidos.add("events:tipo_" + typeof item.events);
    if (!Array.isArray(item.additional_information)) {
      camposInvalidos.add("additional_information:tipo_" + typeof item.additional_information);
    }

    for (const campo of Object.keys(item)) {
      if (![...FOTO_JOGOS_CAMPOS, ...FOTO_JOGOS_ESTRUTURADOS, "events", "additional_information"].includes(campo)) {
        camposInvalidos.add(campo + ":extra");
      }
    }
  }

  return {
    estrutura: Array.isArray(payload?.jogos) ? "jogos_array" : (lista.length ? "array_extraido" : "sem_array_jogos"),
    itens: lista.length,
    itensInvalidos,
    camposInvalidos: Array.from(camposInvalidos).slice(0, 30)
  };
}

function extrairTextoRespostaOpenAI(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();

  const partes = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") partes.push(content.text);
    }
  }

  return partes.join("\n").trim();
}

function parseJsonToleranteFotoJogos(texto) {
  const raw = String(texto || "").trim();
  if (!raw) return null;

  const tentativas = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) tentativas.push(fenced[1].trim());

  const inicioObjeto = raw.indexOf("{");
  const fimObjeto = raw.lastIndexOf("}");
  if (inicioObjeto >= 0 && fimObjeto > inicioObjeto) {
    tentativas.push(raw.slice(inicioObjeto, fimObjeto + 1));
  }

  const inicioArray = raw.indexOf("[");
  const fimArray = raw.lastIndexOf("]");
  if (inicioArray >= 0 && fimArray > inicioArray) {
    tentativas.push(`{"jogos":${raw.slice(inicioArray, fimArray + 1)}}`);
  }

  for (const tentativa of tentativas) {
    try {
      return JSON.parse(tentativa);
    } catch {}
  }

  return null;
}

async function repararJsonJogosFotoOpenAI(textoOriginal) {
  const texto = String(textoOriginal || "").trim();
  if (!texto) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(FOTO_JOGOS_OPENAI_TIMEOUT_MS, 30000));

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: FOTO_JOGOS_OPENAI_MODEL,
        store: false,
        max_output_tokens: FOTO_JOGOS_OPENAI_MAX_OUTPUT_TOKENS,
        reasoning: { effort: FOTO_JOGOS_OPENAI_REASONING_EFFORT },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Repare somente este JSON de confrontos extraido anteriormente.",
                  "Nao adicione confrontos, nomes, datas ou campos que nao estejam no texto.",
                  "Converta null e campos ausentes para string vazia, remova propriedades extras e retorne apenas o objeto {\"jogos\":[]}.",
                  "Preserve todas as informacoes existentes e as quebras de linha do campo observacao.",
                  texto.slice(0, 12000)
                ].join("\n")
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "reparar_jogos_por_foto",
            strict: true,
            schema: FOTO_JOGOS_JSON_SCHEMA
          }
        }
      })
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) return null;
    return parseJsonToleranteFotoJogos(extrairTextoRespostaOpenAI(data));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function identificarJogosPorFotoOpenAI(file, options = {}) {
  const mime = normalizarMimeImagem(file?.detected_mimetype || file?.mimetype || "");
  const base64 = fs.readFileSync(file.path).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FOTO_JOGOS_OPENAI_TIMEOUT_MS);

  const prompt = [
    "Voce extrai somente confrontos de jogos claramente visiveis em imagens.",
    "Retorne jogos somente quando houver dois times claramente identificaveis.",
    "Nao invente informacoes. Campos ausentes devem ser strings vazias.",
    "Use o campo competicao somente para campeonato, torneio, copa, liga ou nome da competicao. Nao coloque rodada ou fase nesse campo.",
    "Nao confunda campeonato, patrocinador, apoio, realizacao, organizador, categoria, grupo, rodada ou local com nome de time.",
    "Nao transforme classificacao, ranking, tabela de pontos ou lista de equipes em confronto sem evidencia textual/visual de jogo entre dois times.",
    "Remova duplicados exatos. Preserve jogos entre os mesmos times quando rodada, data, horario, fase, numero do jogo, categoria ou grupo forem diferentes.",
    "Se a imagem estiver ilegivel, ambigua ou sem confronto confiavel, retorne jogos como array vazio.",
    "Preencha resultado_gols_a e resultado_gols_b somente quando o placar do confronto estiver claramente visivel. Deixe ambos vazios quando nao houver placar confiavel.",
    "Procure e preserve, quando legiveis: fase, rodada, data, horario, numero do jogo, categoria, grupo, local, cidade, ginasio ou estadio, modalidade, futebol ou futsal, masculino ou feminino e mando de campo.",
    "Trate a tarefa como extracao esportiva detalhada, nunca como resumo curto.",
    "Preencha os campos estruturados status, placar_tempo_normal, placar_final, disputa_penaltis, cidade, estadio_ginasio, modalidade, genero, classificacao, patrocinadores, organizador e transmissao quando legiveis.",
    "Registre cada gol, cartao, expulsao ou substituicao em events. Para gols, type deve ser 'goal' e player, team e minute devem preservar exatamente nomes, acentos e minutos visiveis; use details para gol contra, penalti ou outra qualificacao.",
    "Repita eventos quando o mesmo jogador marcar mais de uma vez; nunca combine nem elimine minutos diferentes.",
    "Use additional_information para outros dados esportivos legiveis e uteis. Use observacao apenas para informacao que nao caiba nos campos estruturados.",
    "Em Resultado, autores dos gols e minutos tem prioridade absoluta sobre informacoes secundarias.",
    "Nunca use patrocinador, organizador, transmissao, competicao ou classificacao como nome de time.",
    "Quando uma leitura util estiver incerta, escreva em additional_information no formato 'Possivel ... - confirmar.'; nao transforme suspeita em fato.",
    "So marque algo como possivel quando o texto estiver realmente parcialmente legivel. Nao crie duvida sobre associacoes claras por alinhamento, coluna ou proximidade visual.",
    "Preserve acentos, pontuacao, nomes proprios, ordem logica e quebras de linha.",
    "Observacao pode ter ate 1.200 caracteres. Se houver mais conteudo, priorize autores dos gols e dados diretamente uteis a arte, sem cortar palavras, e informe que o restante foi resumido.",
    "Escudos podem ajudar a identificar os times, mas nao recorte nem invente arquivos de escudo; o cliente adicionara as imagens separadamente."
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: FOTO_JOGOS_OPENAI_MODEL,
        store: false,
        max_output_tokens: FOTO_JOGOS_OPENAI_MAX_OUTPUT_TOKENS,
        reasoning: { effort: FOTO_JOGOS_OPENAI_REASONING_EFFORT },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: `data:${mime};base64,${base64}`, detail: "high" }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "identificar_jogos_por_foto",
            strict: true,
            schema: FOTO_JOGOS_JSON_SCHEMA
          }
        }
      })
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const err = new Error("Nao foi possivel analisar a imagem agora. Tente novamente em instantes.");
      err.status = 502;
      err.openaiStatus = response.status;
      err.openaiErrorType = data?.error?.type || "";
      err.openaiErrorCode = data?.error?.code || "";
      throw err;
    }

    const texto = extrairTextoRespostaOpenAI(data);
    let payload = parseJsonToleranteFotoJogos(texto);
    let jogos = normalizarRespostaJogosFoto(payload);

    if (!payload && texto) {
      const reparado = await repararJsonJogosFotoOpenAI(texto);
      if (reparado) {
        payload = reparado;
        jogos = normalizarRespostaJogosFoto(payload);
      }
    }

    if (!payload || data?.status === "incomplete") {
      console.warn("[IDENTIFICAR_JOGOS_FOTO_SCHEMA_TOLERANTE]", {
        tipo: !payload ? "json_ausente_ou_invalido" : "resposta_incompleta",
        motivo: data?.incomplete_details?.reason || "",
        texto_presente: !!texto,
        jogos_preservados: jogos.length
      });
    } else {
      const diagnostico = diagnosticarPayloadJogosFoto(payload);
      if (diagnostico.camposInvalidos.length || diagnostico.estrutura !== "jogos_array") {
        console.warn("[IDENTIFICAR_JOGOS_FOTO_SCHEMA_TOLERANTE]", {
          tipo: "normalizacao_tolerante",
          estrutura: diagnostico.estrutura,
          itens: diagnostico.itens,
          itens_invalidos: diagnostico.itensInvalidos,
          campos_invalidos: diagnostico.camposInvalidos,
          jogos_preservados: jogos.length
        });
      }
    }

    return options.includeRaw === true ? { raw: payload, jogos } : jogos;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutErr = new Error("Tempo esgotado ao analisar a imagem.");
      timeoutErr.status = 504;
      timeoutErr.timeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizarTipoImagemPerfil(value) {
  const tipo = String(value || "").trim().toLowerCase();
  return PERFIL_IMAGEM_TIPOS.has(tipo) ? tipo : "";
}

function getPerfilImagemFile(perfilId, tipo, ext = "") {
  const safeTipo = normalizarTipoImagemPerfil(tipo);
  if (!safeTipo) return "";
  const safeExt = String(ext || "").match(/^\.(png|jpg|jpeg|webp)$/i) ? String(ext).toLowerCase() : "";
  return path.join(getPerfilAssetsDir(perfilId), `${safeTipo}${safeExt}`);
}

function perfilImagemUrl(tipo) {
  return `/me/time/perfil/${tipo}/imagem`;
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

function jogadorPublicoResponse(jogador) {
  return {
    nome: jogador.nome,
    apelido: jogador.apelido || "",
    numero: jogador.numero || "",
    posicao: jogador.posicao || ""
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

function gerarPatrocinadorId() {
  return `pat_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizarPatrocinadorId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "").slice(0, 80);
}

function normalizarSitePatrocinador(value) {
  const raw = assetPerfil(value || "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.slice(0, 220);
  return `https://${raw}`.slice(0, 220);
}

function patrocinadorResponse(patrocinador, { publico = false, slug = "" } = {}) {
  const logoUrl = patrocinador.logo_path
    ? (
        publico && slug
          ? `/time/${encodeURIComponent(slug)}/patrocinadores/${encodeURIComponent(patrocinador.id)}/logo`
          : `/me/time/patrocinadores/${encodeURIComponent(patrocinador.id)}/logo`
      )
    : "";

  return {
    id: patrocinador.id,
    nome: patrocinador.nome,
    instagram: patrocinador.instagram || "",
    site: patrocinador.site || "",
    logo_url: logoUrl,
    ativo: patrocinador.ativo !== false,
    criado_em: patrocinador.criado_em,
    atualizado_em: patrocinador.atualizado_em
  };
}

function patrocinadorPublicoResponse(patrocinador, slug = "") {
  const logoUrl = patrocinador.logo_path && slug
    ? `/time/${encodeURIComponent(slug)}/patrocinadores/${encodeURIComponent(patrocinador.id)}/logo`
    : "";

  return {
    nome: patrocinador.nome,
    instagram: patrocinador.instagram || "",
    site: patrocinador.site || "",
    logo_url: logoUrl
  };
}

function normalizarPatrocinador(patrocinador) {
  const base = patrocinador && typeof patrocinador === "object" && !Array.isArray(patrocinador)
    ? patrocinador
    : {};
  const agora = new Date().toISOString();

  return {
    id: normalizarPatrocinadorId(base.id) || gerarPatrocinadorId(),
    nome: textoPerfil(base.nome || "", 80),
    instagram: normalizarInstagramPerfil(base.instagram || ""),
    site: normalizarSitePatrocinador(base.site || ""),
    logo_path: assetPerfil(base.logo_path || ""),
    logo_mime: textoPerfil(base.logo_mime || "", 40),
    ativo: base.ativo !== false,
    criado_em: base.criado_em || agora,
    atualizado_em: base.atualizado_em || agora
  };
}

function readPerfilPatrocinadores(perfilId) {
  return readJsonArraySafe(getPerfilPatrocinadoresFile(perfilId))
    .map(normalizarPatrocinador)
    .filter(patrocinador => patrocinador.id);
}

function writePerfilPatrocinadores(perfilId, patrocinadores) {
  ensureDir(getPerfilDir(perfilId));
  writeJsonSafe(getPerfilPatrocinadoresFile(perfilId), patrocinadores.map(patrocinador => ({
    ...normalizarPatrocinador(patrocinador)
  })));
}

function payloadPatrocinador(body, atual = {}) {
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body
    : {};
  const agora = new Date().toISOString();

  return normalizarPatrocinador({
    ...atual,
    nome: payload.nome ?? atual.nome,
    instagram: payload.instagram ?? atual.instagram,
    site: payload.site ?? atual.site,
    logo_path: atual.logo_path,
    logo_mime: atual.logo_mime,
    ativo: typeof payload.ativo === "boolean" ? payload.ativo : atual.ativo,
    atualizado_em: agora
  });
}

function escalacaoDefault() {
  return {
    titulares: [],
    reservas: [],
    atualizado_em: ""
  };
}

function escalacaoJogadoresMap(jogadores = []) {
  const map = new Map();

  for (const jogador of Array.isArray(jogadores) ? jogadores : []) {
    if (!jogador || jogador.ativo === false || !jogador.id) continue;
    map.set(jogador.id, jogador);
  }

  return map;
}

function normalizarEscalacaoGrupo(itens, tipo, jogadoresMap, usados) {
  const lista = Array.isArray(itens) ? itens : [];
  const normalizados = [];

  for (const item of lista) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (normalizados.length >= 30) break;

    const jogadorId = normalizarJogadorId(item.jogador_id || item.id);
    if (jogadorId && usados.has(jogadorId)) continue;

    const jogador = jogadorId ? jogadoresMap.get(jogadorId) : null;
    if (jogadorId && !jogador) continue;
    if (!jogador) continue;

    const nome = textoPerfil(jogador.nome || "", 80);

    if (!nome) continue;

    usados.add(jogadorId);

    const posicaoElenco = textoPerfil(jogador.posicao || "", 40);
    let posicaoOverride = textoPerfil(item.posicao_override || "", 40);

    if (!posicaoOverride) {
      const posicaoLegada = textoPerfil(item.posicao || "", 40);
      if (posicaoLegada && posicaoLegada !== posicaoElenco) {
        posicaoOverride = posicaoLegada;
      }
    }

    normalizados.push({
      jogador_id: jogador.id,
      nome,
      apelido: textoPerfil(jogador.apelido || "", 60),
      numero: textoPerfil(jogador.numero || "", 12),
      posicao: posicaoOverride || posicaoElenco,
      posicao_elenco: posicaoElenco,
      posicao_override: posicaoOverride,
      tipo,
      ordem: normalizados.length + 1
    });
  }

  return normalizados;
}

function normalizarEscalacaoPerfil(raw = {}, jogadores = []) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : {};
  const jogadoresMap = escalacaoJogadoresMap(jogadores);
  const usados = new Set();

  return {
    titulares: normalizarEscalacaoGrupo(base.titulares, "titular", jogadoresMap, usados),
    reservas: normalizarEscalacaoGrupo(base.reservas, "reserva", jogadoresMap, usados),
    atualizado_em: base.atualizado_em || ""
  };
}

function readPerfilEscalacao(perfilId, jogadores = []) {
  const raw = safeReadJson(getPerfilEscalacaoFile(perfilId)) || escalacaoDefault();
  return normalizarEscalacaoPerfil(raw, jogadores);
}

function writePerfilEscalacao(perfilId, escalacao) {
  ensureDir(getPerfilDir(perfilId));
  const limparGrupo = (itens, tipo) => (Array.isArray(itens) ? itens : [])
    .map((item, index) => ({
      jogador_id: normalizarJogadorId(item?.jogador_id || item?.id),
      posicao_override: textoPerfil(item?.posicao_override || "", 40),
      tipo,
      ordem: Number(item?.ordem || index + 1) || index + 1
    }))
    .filter(item => item.jogador_id);
  const payload = {
    titulares: limparGrupo(escalacao?.titulares, "titular"),
    reservas: limparGrupo(escalacao?.reservas, "reserva"),
    atualizado_em: escalacao?.atualizado_em || new Date().toISOString()
  };
  writeJsonSafe(getPerfilEscalacaoFile(perfilId), payload);
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

function jogoPublicoResponse(jogo) {
  return {
    tipo: jogo.tipo,
    adversario: jogo.adversario,
    meu_time_gols: jogo.meu_time_gols || "",
    adversario_gols: jogo.adversario_gols || "",
    data: jogo.data || "",
    horario: jogo.horario || "",
    local: jogo.local || "",
    campeonato: jogo.campeonato || "",
    status: jogo.status || ""
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

function gerarDivisaoId() {
  return `div_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function gerarDivisaoVotoId() {
  return `voto_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function gerarDivisaoShareToken() {
  return crypto
    .randomBytes(24)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizarDivisaoId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "").slice(0, 80);
}

function normalizarDivisaoToken(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 120);
}

function hashVoterTokenDivisao(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizarVotanteUsuarioDivisao(value) {
  return textoPerfil(value || "", 120);
}

function divisaoJogadorSnapshot(jogador) {
  return {
    id: normalizarJogadorId(jogador?.id),
    nome: textoPerfil(jogador?.nome || "Jogador", 80),
    apelido: textoPerfil(jogador?.apelido || "", 60),
    numero: textoPerfil(jogador?.numero || "", 12),
    posicao: textoPerfil(jogador?.posicao || "", 40)
  };
}

function divisaoJogadorResponse(jogador) {
  return divisaoJogadorSnapshot(jogador);
}

function normalizarRankingDivisao(ranking, jogadoresPresentes) {
  const jogadores = Array.isArray(jogadoresPresentes) ? jogadoresPresentes : [];
  const ids = jogadores.map(jogador => normalizarJogadorId(jogador?.id)).filter(Boolean);
  const idsSet = new Set(ids);
  const lista = Array.isArray(ranking) ? ranking : [];

  if (lista.length !== ids.length) {
    const err = new Error("O ranking precisa conter todos os jogadores presentes.");
    err.status = 400;
    throw err;
  }

  const vistos = new Set();

  return lista.map((item, index) => {
    const jogadorId = normalizarJogadorId(item?.jogador_id || item?.id);

    if (!idsSet.has(jogadorId)) {
      const err = new Error("Ranking contem jogador que nao faz parte desta votacao.");
      err.status = 400;
      throw err;
    }

    if (vistos.has(jogadorId)) {
      const err = new Error("Ranking contem jogador repetido.");
      err.status = 400;
      throw err;
    }

    vistos.add(jogadorId);

    return {
      jogador_id: jogadorId,
      posicao: index + 1
    };
  });
}

function normalizarVotoDivisao(voto) {
  const base = voto && typeof voto === "object" && !Array.isArray(voto)
    ? voto
    : {};
  const agora = new Date().toISOString();
  const ranking = Array.isArray(base.ranking)
    ? base.ranking
    : Array.isArray(base.ranking_json)
      ? base.ranking_json
      : [];

  return {
    id: normalizarDivisaoId(base.id) || gerarDivisaoVotoId(),
    voter_user_id: normalizarVotanteUsuarioDivisao(base.voter_user_id || base.usuario_id || base.cliente_id || ""),
    voter_token_hash: String(base.voter_token_hash || "").trim().slice(0, 128),
    nome_votante: textoPerfil(base.nome_votante || "", 80),
    ranking: ranking.map((item, index) => ({
      jogador_id: normalizarJogadorId(item?.jogador_id || item?.id),
      posicao: Number(item?.posicao || index + 1) || index + 1
    })).filter(item => item.jogador_id),
    ranking_bruto: Array.isArray(base.ranking_bruto) ? base.ranking_bruto : ranking,
    criado_em: base.criado_em || agora
  };
}

function normalizarDivisao(sessao) {
  const base = sessao && typeof sessao === "object" && !Array.isArray(sessao)
    ? sessao
    : {};
  const agora = new Date().toISOString();
  const jogadores = Array.isArray(base.jogadores_presentes)
    ? base.jogadores_presentes
    : Array.isArray(base.presentes)
      ? base.presentes
      : [];

  return {
    id: normalizarDivisaoId(base.id) || gerarDivisaoId(),
    perfil_id: normalizarPerfilId(base.perfil_id || ""),
    titulo: textoPerfil(base.titulo || "Dividir Times", 90) || "Dividir Times",
    status: ["aberta", "fechada"].includes(base.status) ? base.status : "aberta",
    share_token: normalizarDivisaoToken(base.share_token || base.token) || gerarDivisaoShareToken(),
    jogadores_presentes: jogadores.map(divisaoJogadorSnapshot).filter(jogador => jogador.id && jogador.nome),
    votos: (Array.isArray(base.votos) ? base.votos : []).map(normalizarVotoDivisao).filter(voto => voto.voter_user_id || voto.voter_token_hash),
    resultado: base.resultado && typeof base.resultado === "object" && !Array.isArray(base.resultado) ? base.resultado : null,
    criado_por: textoPerfil(base.criado_por || "", 120),
    criado_em: base.criado_em || agora,
    atualizado_em: base.atualizado_em || agora
  };
}

function readPerfilDivisoes(perfilId) {
  return readJsonArraySafe(getPerfilDivisoesFile(perfilId))
    .map(sessao => normalizarDivisao({ ...sessao, perfil_id: perfilId }))
    .filter(sessao => sessao.id && sessao.share_token);
}

function writePerfilDivisoes(perfilId, divisoes) {
  ensureDir(getPerfilDir(perfilId));
  const payload = (Array.isArray(divisoes) ? divisoes : [])
    .map(sessao => normalizarDivisao({ ...sessao, perfil_id: perfilId }));
  writeJsonSafe(getPerfilDivisoesFile(perfilId), payload);
}

function divisaoResponse(sessao, { publico = false } = {}) {
  const normalizada = normalizarDivisao(sessao);
  const response = {
    id: normalizada.id,
    titulo: normalizada.titulo,
    status: normalizada.status,
    jogadores_presentes: normalizada.jogadores_presentes.map(divisaoJogadorResponse),
    votos_count: normalizada.votos.length,
    criado_em: normalizada.criado_em,
    atualizado_em: normalizada.atualizado_em
  };

  if (!publico) {
    response.share_token = normalizada.share_token;
    response.resultado = normalizada.resultado ? resultadoDivisaoResponse(normalizada.resultado) : null;
  }

  return response;
}

function resultadoDivisaoResponse(resultado) {
  const base = resultado && typeof resultado === "object" && !Array.isArray(resultado)
    ? resultado
    : {};

  return {
    time_a: (Array.isArray(base.time_a) ? base.time_a : []).map(divisaoJogadorResponse),
    time_b: (Array.isArray(base.time_b) ? base.time_b : []).map(divisaoJogadorResponse),
    forca_a: Number(base.forca_a || 0),
    forca_b: Number(base.forca_b || 0),
    diferenca: Number(base.diferenca || 0),
    votos_count: Number(base.votos_count || 0),
    gerado_em: base.gerado_em || ""
  };
}

function calcularScoresDivisao(jogadoresPresentes, votos) {
  const jogadores = Array.isArray(jogadoresPresentes) ? jogadoresPresentes : [];
  const totalJogadores = jogadores.length;
  const acumulado = new Map(jogadores.map(jogador => [jogador.id, { soma: 0, votos: 0 }]));

  for (const voto of Array.isArray(votos) ? votos : []) {
    const ranking = Array.isArray(voto?.ranking) ? voto.ranking : [];

    ranking.forEach((item, index) => {
      const jogadorId = normalizarJogadorId(item?.jogador_id || item?.id);
      const atual = acumulado.get(jogadorId);

      if (atual) {
        atual.soma += totalJogadores - index;
        atual.votos += 1;
      }
    });
  }

  const fallback = totalJogadores ? (totalJogadores + 1) / 2 : 0;
  const scores = {};

  for (const jogador of jogadores) {
    const atual = acumulado.get(jogador.id);
    const media = atual?.votos ? atual.soma / atual.votos : fallback;
    scores[jogador.id] = Math.round(media * 100) / 100;
  }

  return scores;
}

function normalizarTextoComparacaoDivisao(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function grupoPosicaoDivisao(posicao) {
  const texto = normalizarTextoComparacaoDivisao(posicao);
  if (!texto) return "";

  if (/\b(goleiro|gol|keeper|guarda[\s-]?redes)\b/.test(texto)) return "goleiro";
  if (/\b(zagueiro|zaga|defensor|defesa|lateral|beque|back)\b/.test(texto)) return "defesa";
  if (/\b(meia|meio|volante|armador|central)\b/.test(texto)) return "meio";
  if (/\b(atacante|ataque|ponta|centroavante|avante|ala)\b/.test(texto)) return "ataque";

  return "";
}

function calcularPenalidadeTopDivisao(setTimeA, indicesOrdenados) {
  const regras = [
    { tamanho: 2, peso: 1000 },
    { tamanho: 4, peso: 100 },
    { tamanho: 6, peso: 50 }
  ];

  return regras.reduce((total, regra) => {
    if (indicesOrdenados.length < regra.tamanho) return total;

    const grupo = indicesOrdenados.slice(0, regra.tamanho);
    const noTimeA = grupo.filter(index => setTimeA.has(index)).length;
    const noTimeB = regra.tamanho - noTimeA;
    const diferencaIdeal = regra.tamanho % 2;
    const excesso = Math.max(0, Math.abs(noTimeA - noTimeB) - diferencaIdeal);

    return total + excesso * regra.peso;
  }, 0);
}

function calcularPenalidadePosicaoDivisao(jogadores, setTimeA) {
  const grupos = new Map();

  jogadores.forEach((jogador, index) => {
    const grupo = grupoPosicaoDivisao(jogador?.posicao);
    if (!grupo) return;
    if (!grupos.has(grupo)) grupos.set(grupo, []);
    grupos.get(grupo).push(index);
  });

  let penalidade = 0;

  for (const [grupo, indices] of grupos.entries()) {
    if (indices.length < 2) continue;

    const noTimeA = indices.filter(index => setTimeA.has(index)).length;
    const noTimeB = indices.length - noTimeA;
    const diferencaIdeal = indices.length % 2;
    const excesso = Math.max(0, Math.abs(noTimeA - noTimeB) - diferencaIdeal);
    const peso = grupo === "goleiro" ? 20 : 4;

    penalidade += excesso * peso;
  }

  return penalidade;
}

function calcularPenalidadeQuantidadeDivisao(totalJogadores, qtdeTimeA) {
  const qtdeTimeB = totalJogadores - qtdeTimeA;
  return Math.max(0, Math.abs(qtdeTimeA - qtdeTimeB) - 1);
}

function escolherTimesDivisao(jogadoresPresentes, scores) {
  const jogadores = Array.isArray(jogadoresPresentes) ? jogadoresPresentes : [];
  const totalJogadores = jogadores.length;

  if (totalJogadores < 2) {
    const err = new Error("Selecione pelo menos 2 jogadores.");
    err.status = 400;
    throw err;
  }

  const targetSizes = [...new Set([
    Math.floor(totalJogadores / 2),
    Math.ceil(totalJogadores / 2)
  ])].filter(Boolean);
  const values = jogadores.map(jogador => Number(scores?.[jogador.id] || 0));
  const totalForca = values.reduce((sum, value) => sum + value, 0);
  const indicesOrdenados = jogadores
    .map((jogador, index) => ({
      index,
      nome: normalizarTextoComparacaoDivisao(jogador?.apelido || jogador?.nome || ""),
      score: values[index]
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.nome.localeCompare(b.nome);
    })
    .map(item => item.index);
  let best = null;

  function evaluate(indexes) {
    const setTimeA = new Set(indexes);
    const forcaA = indexes.reduce((sum, index) => sum + values[index], 0);
    const forcaB = totalForca - forcaA;
    const diff = Math.abs(forcaA - forcaB);
    const penalidadeTop = calcularPenalidadeTopDivisao(setTimeA, indicesOrdenados);
    const penalidadePosicao = calcularPenalidadePosicaoDivisao(jogadores, setTimeA);
    const penalidadeQuantidade = calcularPenalidadeQuantidadeDivisao(totalJogadores, indexes.length);
    const scoreFinal = diff * 10 + penalidadeTop * 20 + penalidadePosicao * 5 + penalidadeQuantidade * 100;

    if (
      !best ||
      scoreFinal < best.scoreFinal ||
      scoreFinal === best.scoreFinal && diff < best.diff ||
      scoreFinal === best.scoreFinal && diff === best.diff && penalidadeTop < best.penalidadeTop ||
      scoreFinal === best.scoreFinal && diff === best.diff && penalidadeTop === best.penalidadeTop && penalidadePosicao < best.penalidadePosicao
    ) {
      best = {
        indexes: setTimeA,
        diff,
        forcaA,
        forcaB,
        scoreFinal,
        penalidadeTop,
        penalidadePosicao,
        penalidadeQuantidade
      };
    }
  }

  function combine(start, needed, picked) {
    if (needed === 0) {
      evaluate(picked);
      return;
    }

    for (let i = start; i <= totalJogadores - needed; i += 1) {
      picked.push(i);
      combine(i + 1, needed - 1, picked);
      picked.pop();
    }
  }

  if (totalJogadores <= 22) {
    targetSizes.forEach(size => combine(0, size, []));
  } else {
    const sorted = jogadores
      .map((jogador, index) => ({ index, score: values[index] }))
      .sort((a, b) => b.score - a.score);
    const picked = [];
    let sumA = 0;
    let sumB = 0;

    for (const item of sorted) {
      if (picked.length < Math.ceil(totalJogadores / 2) && sumA <= sumB) {
        picked.push(item.index);
        sumA += item.score;
      } else {
        sumB += item.score;
      }
    }

    evaluate(picked);
  }

  const timeA = [];
  const timeB = [];

  jogadores.forEach((jogador, index) => {
    if (best.indexes.has(index)) timeA.push(jogador);
    else timeB.push(jogador);
  });

  return {
    time_a: timeA.map(divisaoJogadorResponse),
    time_b: timeB.map(divisaoJogadorResponse),
    forca_a: Math.round(best.forcaA * 100) / 100,
    forca_b: Math.round(best.forcaB * 100) / 100,
    diferenca: Math.round(best.diff * 100) / 100
  };
}

function gerarResultadoDivisao(sessao) {
  const normalizada = normalizarDivisao(sessao);

  if (!normalizada.votos.length) {
    const err = new Error("Receba pelo menos 1 voto antes de gerar os times.");
    err.status = 400;
    throw err;
  }

  const scores = calcularScoresDivisao(normalizada.jogadores_presentes, normalizada.votos);
  const times = escolherTimesDivisao(normalizada.jogadores_presentes, scores);

  return {
    ...times,
    votos_count: normalizada.votos.length,
    gerado_em: new Date().toISOString()
  };
}

function encontrarDivisaoPorToken(token) {
  const shareToken = normalizarDivisaoToken(token);
  if (!shareToken || !fs.existsSync(PERFIS_DIR)) return null;

  const dirs = fs.readdirSync(PERFIS_DIR, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => item.name);

  for (const perfilId of dirs) {
    const divisoes = readPerfilDivisoes(perfilId);
    const index = divisoes.findIndex(sessao => sessao.share_token === shareToken);

    if (index >= 0) {
      return {
        perfil_id: perfilId,
        divisoes,
        index,
        sessao: divisoes[index]
      };
    }
  }

  return null;
}

const AVALIACAO_JOGADORES_ATRIBUTOS = [
  "velocidade",
  "finalizacao",
  "passe",
  "drible",
  "defesa",
  "fisico",
  "resistencia"
];
const AVALIACAO_JOGADORES_BASE = 75;
const AVALIACAO_JOGADORES_TETO = 99;
const AVALIACAO_JOGADORES_PONTOS_TOTAL = 30;

function gerarAvaliacaoJogadoresId() {
  return `avj_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function gerarAvaliacaoJogadoresVotoId() {
  return `avv_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function gerarAvaliacaoJogadoresShareToken() {
  return gerarDivisaoShareToken();
}

function normalizarAvaliacaoJogadoresId(value) {
  return String(value || "").trim().replace(/[^\w-]+/g, "").slice(0, 80);
}

function normalizarAvaliacaoJogadoresToken(value) {
  return normalizarDivisaoToken(value);
}

function hashVoterTokenAvaliacaoJogadores(value) {
  return hashVoterTokenDivisao(value);
}

function avaliacaoJogadorSnapshot(jogador) {
  return divisaoJogadorSnapshot(jogador);
}

function avaliacaoJogadorResponse(jogador) {
  return avaliacaoJogadorSnapshot(jogador);
}

function pontosAvaliacaoDefault() {
  return AVALIACAO_JOGADORES_ATRIBUTOS.reduce((acc, atributo) => {
    acc[atributo] = 0;
    return acc;
  }, {});
}

function normalizarPontosAvaliacaoLeitura(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pontos = {};

  for (const atributo of AVALIACAO_JOGADORES_ATRIBUTOS) {
    const value = Math.trunc(Number(base[atributo] || 0));
    pontos[atributo] = Number.isFinite(value) && value > 0 ? value : 0;
  }

  return pontos;
}

function normalizarPontosAvaliacaoEnvio(raw, nomeTipo) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const pontos = {};
  let total = 0;

  for (const atributo of AVALIACAO_JOGADORES_ATRIBUTOS) {
    const valueRaw = base[atributo] ?? 0;
    const value = Math.trunc(Number(valueRaw));

    if (!Number.isFinite(value) || value < 0) {
      const err = new Error(nomeTipo ? `Pontuacao invalida em ${nomeTipo}.` : "Pontuacao invalida.");
      err.status = 400;
      throw err;
    }

    pontos[atributo] = value;
    total += value;
  }

  return { pontos, total };
}

function incrementoAvaliacaoPorValor(valor) {
  const atual = Number(valor || AVALIACAO_JOGADORES_BASE);

  if (atual >= AVALIACAO_JOGADORES_TETO) return 0;
  if (atual <= 80) return 4;
  if (atual <= 88) return 3;
  if (atual <= 92) return 2;
  return 1;
}

function calcularValorAtributoAvaliacao(pontos, { rejeitarExcesso = false } = {}) {
  const total = Math.trunc(Number(pontos || 0));
  let valor = AVALIACAO_JOGADORES_BASE;

  for (let i = 0; i < total; i += 1) {
    if (valor >= AVALIACAO_JOGADORES_TETO) {
      if (rejeitarExcesso) {
        const err = new Error("Nenhum atributo pode passar de 99.");
        err.status = 400;
        throw err;
      }
      return AVALIACAO_JOGADORES_TETO;
    }

    valor += incrementoAvaliacaoPorValor(valor);
  }

  return Math.min(AVALIACAO_JOGADORES_TETO, valor);
}

function totalPontosAvaliacao(pontos) {
  return Object.values(normalizarPontosAvaliacaoLeitura(pontos))
    .reduce((sum, value) => sum + value, 0);
}

function normalizarAvaliacaoJogadorVotoItem(item = {}) {
  const base = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const pontosBase = base.pontos || base.pontos_normais || base.normais || {};
  const pontos = normalizarPontosAvaliacaoLeitura(pontosBase);

  return {
    jogador_id: normalizarJogadorId(base.jogador_id || base.id),
    pontos,
    pontos_total: Number(base.pontos_total ?? totalPontosAvaliacao(pontos)) || 0
  };
}

function normalizarAvaliacoesJogadoresPayload(avaliacoes, jogadoresSessao) {
  const jogadores = Array.isArray(jogadoresSessao) ? jogadoresSessao : [];
  const ids = jogadores.map(jogador => normalizarJogadorId(jogador?.id)).filter(Boolean);
  const idsSet = new Set(ids);
  const lista = Array.isArray(avaliacoes) ? avaliacoes : [];

  if (lista.length !== ids.length) {
    const err = new Error("A avaliacao precisa conter todos os jogadores selecionados.");
    err.status = 400;
    throw err;
  }

  const vistos = new Set();

  return lista.map(item => {
    const jogadorId = normalizarJogadorId(item?.jogador_id || item?.id);

    if (!idsSet.has(jogadorId)) {
      const err = new Error("Avaliacao contem jogador que nao faz parte desta sessao.");
      err.status = 400;
      throw err;
    }

    if (vistos.has(jogadorId)) {
      const err = new Error("Avaliacao contem jogador repetido.");
      err.status = 400;
      throw err;
    }

    vistos.add(jogadorId);

    const pontos = normalizarPontosAvaliacaoEnvio(
      item?.pontos || item?.pontos_normais || item?.normais || {},
      ""
    );

    for (const atributo of AVALIACAO_JOGADORES_ATRIBUTOS) {
      calcularValorAtributoAvaliacao(pontos.pontos[atributo] || 0, { rejeitarExcesso: true });
    }

    if (pontos.total > AVALIACAO_JOGADORES_PONTOS_TOTAL) {
      const err = new Error(`Voce passou do limite de ${AVALIACAO_JOGADORES_PONTOS_TOTAL} ponto(s).`);
      err.status = 400;
      throw err;
    }

    return {
      jogador_id: jogadorId,
      pontos: pontos.pontos,
      pontos_total: pontos.total
    };
  });
}

function normalizarVotoAvaliacaoJogadores(voto) {
  const base = voto && typeof voto === "object" && !Array.isArray(voto) ? voto : {};
  const avaliacoes = Array.isArray(base.avaliacoes)
    ? base.avaliacoes
    : Array.isArray(base.jogadores)
      ? base.jogadores
      : [];

  return {
    id: normalizarAvaliacaoJogadoresId(base.id) || gerarAvaliacaoJogadoresVotoId(),
    voter_user_id: normalizarVotanteUsuarioDivisao(base.voter_user_id || base.usuario_id || base.cliente_id || ""),
    voter_token_hash: String(base.voter_token_hash || "").trim().slice(0, 128),
    nome_votante: textoPerfil(base.nome_votante || "", 80),
    avaliacoes: avaliacoes
      .map(normalizarAvaliacaoJogadorVotoItem)
      .filter(item => item.jogador_id),
    criado_em: base.criado_em || new Date().toISOString()
  };
}

function normalizarAvaliacaoJogadoresSessao(sessao) {
  const base = sessao && typeof sessao === "object" && !Array.isArray(sessao) ? sessao : {};
  const jogadores = Array.isArray(base.jogadores_avaliados)
    ? base.jogadores_avaliados
    : Array.isArray(base.jogadores)
      ? base.jogadores
      : [];
  const agora = new Date().toISOString();

  return {
    id: normalizarAvaliacaoJogadoresId(base.id) || gerarAvaliacaoJogadoresId(),
    perfil_id: normalizarPerfilId(base.perfil_id || ""),
    titulo: textoPerfil(base.titulo || "Avaliar Jogadores", 90) || "Avaliar Jogadores",
    status: ["aberta", "fechada"].includes(base.status) ? base.status : "aberta",
    share_token: normalizarAvaliacaoJogadoresToken(base.share_token || base.token) || gerarAvaliacaoJogadoresShareToken(),
    jogadores_avaliados: jogadores.map(avaliacaoJogadorSnapshot).filter(jogador => jogador.id && jogador.nome),
    votos: (Array.isArray(base.votos) ? base.votos : []).map(normalizarVotoAvaliacaoJogadores).filter(voto => voto.voter_user_id || voto.voter_token_hash),
    criado_por: textoPerfil(base.criado_por || "", 120),
    criado_em: base.criado_em || agora,
    atualizado_em: base.atualizado_em || agora
  };
}

function readPerfilAvaliacoesJogadores(perfilId) {
  return readJsonArraySafe(getPerfilAvaliacoesJogadoresFile(perfilId))
    .map(sessao => normalizarAvaliacaoJogadoresSessao({ ...sessao, perfil_id: perfilId }))
    .filter(sessao => sessao.id && sessao.share_token);
}

function writePerfilAvaliacoesJogadores(perfilId, avaliacoes) {
  ensureDir(getPerfilDir(perfilId));
  const payload = (Array.isArray(avaliacoes) ? avaliacoes : [])
    .map(sessao => normalizarAvaliacaoJogadoresSessao({ ...sessao, perfil_id: perfilId }));
  writeJsonSafe(getPerfilAvaliacoesJogadoresFile(perfilId), payload);
}

function normalizarTextoPosicaoAvaliacao(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function pesosOverallAvaliacao(posicao) {
  const texto = normalizarTextoPosicaoAvaliacao(posicao);
  const base = {
    velocidade: 1,
    finalizacao: 1,
    passe: 1,
    drible: 1,
    defesa: 1,
    fisico: 1,
    resistencia: 1
  };

  if (/\b(goleiro|gol|keeper|guarda[\s-]?redes)\b/.test(texto)) {
    return { velocidade: 0.1, finalizacao: 0.05, passe: 0.1, drible: 0.05, defesa: 0.35, fisico: 0.2, resistencia: 0.15 };
  }

  if (/\b(zagueiro|zaga|defensor|defesa|fixo|beque)\b/.test(texto)) {
    return { velocidade: 0.1, finalizacao: 0.025, passe: 0.15, drible: 0.025, defesa: 0.35, fisico: 0.2, resistencia: 0.15 };
  }

  if (/\b(lateral|ala)\b/.test(texto)) {
    return { velocidade: 0.22, finalizacao: 0.03, passe: 0.15, drible: 0.15, defesa: 0.18, fisico: 0.07, resistencia: 0.2 };
  }

  if (/\b(volante|marcador)\b/.test(texto)) {
    return { velocidade: 0.08, finalizacao: 0.05, passe: 0.22, drible: 0.07, defesa: 0.25, fisico: 0.15, resistencia: 0.18 };
  }

  if (/\b(meia|armador|meio)\b/.test(texto)) {
    return { velocidade: 0.12, finalizacao: 0.15, passe: 0.25, drible: 0.2, defesa: 0.08, fisico: 0.08, resistencia: 0.12 };
  }

  if (/\b(pivo|pivô)\b/.test(texto)) {
    return { velocidade: 0.07, finalizacao: 0.25, passe: 0.15, drible: 0.15, defesa: 0.08, fisico: 0.2, resistencia: 0.1 };
  }

  if (/\b(atacante|ataque|ponta|centroavante|avante)\b/.test(texto)) {
    return { velocidade: 0.2, finalizacao: 0.25, passe: 0.1, drible: 0.2, defesa: 0.05, fisico: 0.1, resistencia: 0.1 };
  }

  return base;
}

function calcularOverallAvaliacao(atributos, posicao) {
  const pesos = pesosOverallAvaliacao(posicao);
  let soma = 0;
  let totalPeso = 0;

  for (const atributo of AVALIACAO_JOGADORES_ATRIBUTOS) {
    const peso = Number(pesos[atributo] || 0);
    soma += Number(atributos?.[atributo] || AVALIACAO_JOGADORES_BASE) * peso;
    totalPeso += peso;
  }

  if (!totalPeso) return AVALIACAO_JOGADORES_BASE;
  return Math.round((soma / totalPeso) * 10) / 10;
}

function calcularResultadosAvaliacaoJogadores(sessao) {
  const normalizada = normalizarAvaliacaoJogadoresSessao(sessao);
  const acumulado = new Map(normalizada.jogadores_avaliados.map(jogador => [
    jogador.id,
    {
      jogador,
      votos: 0,
      pontos: pontosAvaliacaoDefault(),
      valores: pontosAvaliacaoDefault()
    }
  ]));

  for (const voto of normalizada.votos) {
    const vistosNoVoto = new Set();

    for (const avaliacao of Array.isArray(voto.avaliacoes) ? voto.avaliacoes : []) {
      const jogadorId = normalizarJogadorId(avaliacao?.jogador_id);
      const atual = acumulado.get(jogadorId);
      if (!atual || vistosNoVoto.has(jogadorId)) continue;
      vistosNoVoto.add(jogadorId);
      atual.votos += 1;

      for (const atributo of AVALIACAO_JOGADORES_ATRIBUTOS) {
        const pontos = Number(avaliacao.pontos?.[atributo] || 0);
        atual.pontos[atributo] += pontos;
        atual.valores[atributo] += calcularValorAtributoAvaliacao(pontos);
      }
    }
  }

  return normalizada.jogadores_avaliados.map(jogador => {
    const atual = acumulado.get(jogador.id);
    const votos = Number(atual?.votos || 0);
    const atributos = {};
    const pontosMedios = {};

    for (const atributo of AVALIACAO_JOGADORES_ATRIBUTOS) {
      const mediaPontos = votos ? atual.pontos[atributo] / votos : 0;
      const valor = votos ? atual.valores[atributo] / votos : AVALIACAO_JOGADORES_BASE;

      pontosMedios[atributo] = Math.round(mediaPontos * 100) / 100;
      atributos[atributo] = Math.round(Math.min(AVALIACAO_JOGADORES_TETO, valor) * 10) / 10;
    }

    return {
      jogador: avaliacaoJogadorResponse(jogador),
      atributos,
      overall: calcularOverallAvaliacao(atributos, jogador.posicao),
      votos_count: votos,
      pontos_medios: pontosMedios
    };
  });
}

function avaliacaoJogadoresConfigResponse() {
  return {
    base: AVALIACAO_JOGADORES_BASE,
    teto: AVALIACAO_JOGADORES_TETO,
    pontos_total: AVALIACAO_JOGADORES_PONTOS_TOTAL,
    regra_pontos: [
      { de: 75, ate: 80, incremento: 4 },
      { de: 81, ate: 88, incremento: 3 },
      { de: 89, ate: 92, incremento: 2 },
      { de: 93, ate: 99, incremento: 1 }
    ],
    atributos: AVALIACAO_JOGADORES_ATRIBUTOS
  };
}

function avaliacaoJogadoresResponse(sessao, { publico = false } = {}) {
  const normalizada = normalizarAvaliacaoJogadoresSessao(sessao);
  const perfilPublico = perfilPublicoResumoPorId(normalizada.perfil_id);
  const response = {
    id: normalizada.id,
    titulo: normalizada.titulo,
    status: normalizada.status,
    jogadores_avaliados: normalizada.jogadores_avaliados.map(avaliacaoJogadorResponse),
    votos_count: normalizada.votos.length,
    config: avaliacaoJogadoresConfigResponse(),
    time: perfilPublico,
    perfil_publico: perfilPublico,
    criado_em: normalizada.criado_em,
    atualizado_em: normalizada.atualizado_em
  };

  if (!publico) {
    response.share_token = normalizada.share_token;
    response.resultados = calcularResultadosAvaliacaoJogadores(normalizada);
  }

  return response;
}

function encontrarAvaliacaoJogadoresPorToken(token) {
  const shareToken = normalizarAvaliacaoJogadoresToken(token);
  if (!shareToken || !fs.existsSync(PERFIS_DIR)) return null;

  const dirs = fs.readdirSync(PERFIS_DIR, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => item.name);

  for (const perfilId of dirs) {
    const avaliacoes = readPerfilAvaliacoesJogadores(perfilId);
    const index = avaliacoes.findIndex(sessao => sessao.share_token === shareToken);

    if (index >= 0) {
      return {
        perfil_id: perfilId,
        avaliacoes,
        index,
        sessao: avaliacoes[index]
      };
    }
  }

  return null;
}

function numeroGolsPerfil(value) {
  const texto = String(value ?? "").trim().replace(",", ".");
  if (!texto) return null;
  const numero = Number(texto);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return Math.floor(numero);
}

function calcularEstatisticasPerfil(jogos = []) {
  const stats = {
    jogos: 0,
    vitorias: 0,
    empates: 0,
    derrotas: 0,
    gols_marcados: 0,
    gols_sofridos: 0,
    saldo_gols: 0,
    pontos: 0,
    aproveitamento: 0
  };

  for (const jogo of Array.isArray(jogos) ? jogos : []) {
    if (!jogo || jogo.ativo === false || jogo.tipo !== "resultado") continue;

    const golsMarcados = numeroGolsPerfil(jogo.meu_time_gols);
    const golsSofridos = numeroGolsPerfil(jogo.adversario_gols);

    if (golsMarcados === null || golsSofridos === null) continue;

    stats.jogos += 1;
    stats.gols_marcados += golsMarcados;
    stats.gols_sofridos += golsSofridos;

    if (golsMarcados > golsSofridos) {
      stats.vitorias += 1;
      stats.pontos += 3;
    } else if (golsMarcados === golsSofridos) {
      stats.empates += 1;
      stats.pontos += 1;
    } else {
      stats.derrotas += 1;
    }
  }

  stats.saldo_gols = stats.gols_marcados - stats.gols_sofridos;
  stats.aproveitamento = stats.jogos
    ? Math.round((stats.pontos / (stats.jogos * 3)) * 1000) / 10
    : 0;

  return stats;
}

const PERFIL_GALERIA_PRODUTOS = new Set([
  "resultado",
  "proximo_jogo",
  "escalacao",
  "jogador_escudo",
  "mascote_uniforme"
]);

function categoriaPedidoGaleria(pedido = {}) {
  return String(pedido.product_id || pedido.categoria || pedido.produto || "")
    .trim()
    .toLowerCase();
}

function encontrarClienteIdPorPerfilId(perfilId) {
  const perfilIdNormalizado = normalizarPerfilId(perfilId);
  if (!perfilIdNormalizado) return "";

  const clientes = readClientes();

  for (const [clienteId, cliente] of Object.entries(clientes)) {
    if (normalizarPerfilId(cliente?.perfil_id) === perfilIdNormalizado) {
      return clienteId;
    }
  }

  return "";
}

function pedidoLiberadoParaGaleria(item) {
  if (!item || !item.base || !item.pedido) return false;

  const categoria = categoriaPedidoGaleria(item.pedido);
  if (!PERFIL_GALERIA_PRODUTOS.has(categoria)) return false;

  const resultadoFinalPath = path.join(item.base, "resultado_final.png");
  if (!fs.existsSync(resultadoFinalPath)) return false;

  return item.pedido.aprovado_cliente === true && item.pedido.pagamento_pendente !== true;
}

function galeriaItemResponse(item, perfilSlug = "", modo = "privado") {
  const categoria = categoriaPedidoGaleria(item.pedido);
  const baseUrl = modo === "publico" && perfilSlug
    ? `/time/${encodeURIComponent(perfilSlug)}/galeria/${encodeURIComponent(item.id)}/imagem`
    : `/me/time/galeria/${encodeURIComponent(item.id)}/imagem`;

  return {
    id: item.id,
    pedido_id: item.id,
    produto: categoria,
    produto_nome: nomeCategoriaPedido(categoria),
    criado_em: item.criado_em || item.pedido.data || "",
    data: item.pedido.data || item.criado_em || "",
    imagem_url: baseUrl
  };
}

function galeriaItemPublicoResponse(item, perfilSlug = "") {
  const categoria = categoriaPedidoGaleria(item.pedido);

  return {
    produto: categoria,
    produto_nome: nomeCategoriaPedido(categoria),
    data: item.pedido.data || item.criado_em || "",
    imagem_url: `/time/${encodeURIComponent(perfilSlug)}/galeria/${encodeURIComponent(item.id)}/imagem`
  };
}

function listarPedidosGaleriaPerfilCliente(clienteId) {
  const cliente = String(clienteId || "").trim();
  if (!cliente) return [];

  return listPedidoBasesByWhatsapp(cliente)
    .filter(pedidoLiberadoParaGaleria);
}

function listarGaleriaPerfilCliente(clienteId, { perfilSlug = "", modo = "privado", limit = 50 } = {}) {
  const maxItens = Math.max(1, Math.min(Number(limit || 50) || 50, 50));
  const itens = listarPedidosGaleriaPerfilCliente(clienteId).slice(0, maxItens);

  return modo === "publico"
    ? itens.map(item => galeriaItemPublicoResponse(item, perfilSlug))
    : itens.map(item => galeriaItemResponse(item, perfilSlug, modo));
}

function contarArtesPerfilCliente(clienteId) {
  return listarPedidosGaleriaPerfilCliente(clienteId).length;
}

function servirImagemGaleriaPedido(req, res, clienteId, pedidoId) {
  const cliente = String(clienteId || "").trim();
  const id = String(pedidoId || "").trim();

  if (!cliente || !id) {
    return res.status(404).json({ ok: false, error: "Imagem nao encontrada" });
  }

  const base = getPedidoBase(cliente, id);
  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido nao encontrado" });
  }

  const pedido = safeReadJson(path.join(base, "pedido.json")) || {};
  const item = { id, base, pedido };

  if (!pedidoLiberadoParaGaleria(item)) {
    return res.status(403).json({ ok: false, error: "Imagem indisponivel para galeria" });
  }

  const arquivo = path.join(base, "resultado_final.png");

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, no-store");

  return res.sendFile(arquivo);
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
  return getExtensaoImagemSegura(mimetype);
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
  const saldoInfo = billingService.getBalanceFields(c);

  return {
    whatsapp,
    cliente_id: whatsapp,
    nome_time: c.nome_time || "",
    login_tipo: c.login_tipo || "whatsapp",
    email: c.email || "",
    foto_google: c.foto_google || "",
    saldo: saldoInfo.saldo,
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

function authOpcional(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    req.user = null;
  }

  return next();
}

function downloadClientInfo(userAgent = "") {
  const ua = String(userAgent || "");
  let browser = "outro";

  if (/Instagram/i.test(ua)) browser = "instagram";
  else if (/WhatsApp/i.test(ua)) browser = "whatsapp";
  else if (/SamsungBrowser/i.test(ua)) browser = "samsung_internet";
  else if (/CriOS/i.test(ua)) browser = "chrome_ios";
  else if (/Chrome|Chromium/i.test(ua)) browser = "chrome";
  else if (/Safari/i.test(ua)) browser = "safari";

  let os = "outro";
  if (/Android/i.test(ua)) os = "android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "ios";
  else if (/Windows/i.test(ua)) os = "windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macos";

  return { browser, os };
}

function authBrowserHandoffEnabled() {
  return ["1", "true", "on", "yes"].includes(
    String(process.env.AUTH_BROWSER_HANDOFF_ENABLED || "").trim().toLowerCase()
  );
}

function authBrowserHandoffHasSecureJwtSecret() {
  const configured = String(process.env.JWT_SECRET || "").trim();
  return (
    Boolean(configured) &&
    Buffer.byteLength(configured, "utf8") >= 24 &&
    configured === JWT_SECRET
  );
}

function setPrivateBrowserHandoffHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function requireAuthBrowserHandoffEnabled(req, res, next) {
  setPrivateBrowserHandoffHeaders(res);

  if (!authBrowserHandoffEnabled()) {
    return res.status(404).json({ ok: false, error: "Recurso nao encontrado." });
  }

  if (!authBrowserHandoffHasSecureJwtSecret()) {
    logAuthBrowserHandoff(req, {
      evento: "handoff_configuracao_indisponivel",
      status: 503,
      motivo: "configuration_unavailable"
    });
    return res.status(503).json({
      ok: false,
      error: "Transferencia temporariamente indisponivel."
    });
  }

  return next();
}

function requireAuthBrowserHandoffOrigin(req, res, next) {
  const origin = String(req.headers.origin || "").trim().toLowerCase();

  if (!AUTH_BROWSER_HANDOFF_ORIGINS.has(origin)) {
    logAuthBrowserHandoff(req, {
      evento: "handoff_origem_recusada",
      status: 403,
      motivo: "origin_forbidden"
    });
    return res.status(403).json({ ok: false, error: "Origem nao permitida." });
  }

  return next();
}

function logAuthBrowserHandoff(req, details = {}) {
  const client = downloadClientInfo(req.headers["user-agent"]);
  const allowedReasons = new Set([
    "account_unavailable",
    "configuration_unavailable",
    "expired",
    "invalid",
    "origin_forbidden",
    "rate_limited",
    "session_expired",
    "storage_busy",
    "storage_unavailable",
    "superseded",
    "unexpected",
    "used"
  ]);
  const rawReason = String(details.motivo || "");
  const allowed = {
    evento: String(details.evento || "auth_handoff"),
    navegador: client.browser,
    sistema: client.os,
    status_http: Number(details.status || 0),
    motivo: allowedReasons.has(rawReason) ? rawReason : "",
    idade_ms: Math.max(0, Number(details.idadeMs || 0)),
    duracao_ms: Math.max(0, Number(details.duracaoMs || 0))
  };

  // Nunca registrar codigo, JWT, Authorization, URL, IP, login ou User-Agent completo.
  console.info("[auth-handoff]", JSON.stringify(allowed));
}

function authBrowserHandoffRateLimited(req, res, result, details = {}) {
  const retryAfterMs = Math.max(1_000, Number(result?.retryAfterMs || 1_000));
  res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  logAuthBrowserHandoff(req, {
    ...details,
    evento: "handoff_rate_limited",
    status: 429,
    motivo: "rate_limited"
  });
  return res.status(429).json({
    ok: false,
    error: "Muitas tentativas. Aguarde um pouco e tente novamente.",
    retry_after: Math.ceil(retryAfterMs / 1000)
  });
}

function authBrowserHandoffStoreFailure(req, res, error, details = {}) {
  const motivo = error instanceof BrowserHandoffStoreError && [
    "storage_busy",
    "storage_unavailable"
  ].includes(error.code)
    ? error.code
    : "unexpected";

  logAuthBrowserHandoff(req, {
    ...details,
    evento: "handoff_store_error",
    status: 503,
    motivo
  });
  return res.status(503).json({
    ok: false,
    error: "Transferencia temporariamente indisponivel. Tente novamente."
  });
}

function logDownloadTechnical(req, details = {}) {
  const client = downloadClientInfo(req.headers["user-agent"]);
  const allowed = {
    evento: String(details.evento || "download"),
    navegador: client.browser,
    sistema: client.os,
    recurso: String(details.recurso || ""),
    pedido_id: String(details.pedidoId || ""),
    rota: String(details.rota || ""),
    status_http: Number(details.status || 0),
    erro: String(details.erro || "").slice(0, 80),
    duracao_ms: Math.max(0, Number(details.duracaoMs || 0))
  };

  // Nunca registrar Authorization, ticket temporario, URL completa ou dados pessoais.
  console.info("[download-tecnico]", JSON.stringify(allowed));
}

function setPrivateDownloadHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function validateOrderDownload(whatsapp, pedidoId, options = {}) {
  const base = getPedidoBase(whatsapp, pedidoId);

  if (!base) {
    return { ok: false, status: 404, error: "Pedido nao encontrado" };
  }

  const pedidoPath = path.join(base, "pedido.json");
  const pedido = safeReadJson(pedidoPath) || {};

  if (pedido.pagamento_pendente === true) {
    return {
      ok: false,
      status: 403,
      error: "Pagamento pendente. Desbloqueie esta imagem antes de baixar."
    };
  }

  if (pedido.aprovado_cliente !== true) {
    return {
      ok: false,
      status: 403,
      error: "Aprove a previa antes de baixar a imagem em alta qualidade."
    };
  }

  const arquivo = path.join(base, "resultado_final.png");
  if (options.requireResult !== false && !fs.existsSync(arquivo)) {
    return { ok: false, status: 404, error: "Resultado final nao encontrado" };
  }

  return { ok: true, base, pedido, pedidoPath, arquivo };
}

function validateCartaDownload(whatsapp, cartaId) {
  const carta = getCartaAppAtivaById(cartaId);

  if (!carta || !cartaAppPermitidaParaCliente(carta, whatsapp)) {
    return { ok: false, status: 404, error: "Imagem nao encontrada" };
  }

  const imagemPath = String(carta.imagem_path || "").trim();
  if (!imagemPath) {
    return {
      ok: false,
      status: 409,
      error: "Esta imagem usa um endereco externo e nao pode ser salva pelo download protegido."
    };
  }

  const base = path.resolve(DATA_DIR);
  const arquivo = path.resolve(DATA_DIR, imagemPath);

  if (!arquivo.startsWith(base + path.sep) || !fs.existsSync(arquivo)) {
    return { ok: false, status: 404, error: "Imagem nao encontrada" };
  }

  return { ok: true, carta, arquivo };
}

function mimeTypeForImageFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function extensionForImageMime(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function ticketErrorResponse(req, res, redeemed, details = {}) {
  const status = redeemed.reason === "expired" || redeemed.reason === "used" ? 410 : 403;
  const error = redeemed.reason === "expired"
    ? "O link de download expirou. Toque em baixar novamente."
    : redeemed.reason === "used"
      ? "Este download temporario ja foi utilizado. Toque em baixar novamente."
      : "Download temporario invalido.";

  logDownloadTechnical(req, {
    ...details,
    evento: "download_recusado",
    status,
    erro: redeemed.reason
  });
  return res.status(status).json({ ok: false, error, codigo: redeemed.reason });
}

function textoLegal(value, max = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function textoLegalMultilinha(value, max = 2000) {
  return String(value || "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, max);
}

function urlLegal(value, max = 500) {
  const raw = textoLegal(value, max);
  if (!raw) return "";

  try {
    const url = new URL(raw, "https://omascote.com.br");
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return url.href.slice(0, max);
  } catch {
    return "";
  }
}

function clienteResumoParaSolicitacao(whatsapp) {
  const clientes = readClientes();
  const cliente = clientes[whatsapp] || {};

  return {
    cliente_id: String(whatsapp || ""),
    whatsapp: String(whatsapp || ""),
    nome_time: textoLegal(cliente.nome_time || cliente.nome || "", 120),
    login_tipo: textoLegal(cliente.login_tipo || "whatsapp", 40),
    perfil_id: normalizarPerfilId(cliente.perfil_id || "")
  };
}

// ===== UPLOAD (multer) =====
const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PERFIL_IMAGE_SIZE = 8 * 1024 * 1024;

const storageDestination = (req, file, cb) =>
  cb(null, path.join(DATA_DIR, "tmp_uploads"));
const storageFilename = (req, file, cb) => {
  const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
  cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safe}`);
};

const storage = multer.diskStorage({
  destination: storageDestination,
  filename: storageFilename
});
const hashingOrderStorage = uploadContentHash.createHashingDiskStorage({
  destination: storageDestination,
  filename: storageFilename
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

const orderUpload = multer({
  storage: hashingOrderStorage,
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

const uploadPerfilImagem = multer({
  storage,
  limits: {
    fileSize: MAX_PERFIL_IMAGE_SIZE
  },
  fileFilter: (req, file, cb) => {
    const permitidos = new Set([
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp"
    ]);

    if (!permitidos.has(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Apenas imagens PNG, JPG e WEBP sao permitidas."));
    }

    cb(null, true);
  }
});

function uploadComErroControlado(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return validarUploadsImagemSeguros(req, res, next);

      if (err.code === "LIMIT_FILE_SIZE") {
        const isPerfilUpload = String(req.originalUrl || req.url || "").includes("/me/time/perfil/");
        const maxMb = isPerfilUpload ? Math.round(MAX_PERFIL_IMAGE_SIZE / (1024 * 1024)) : 50;
        console.warn("[UPLOAD_LIMIT] arquivo_maior_50mb", {
          field: err.field || "",
          url: req.originalUrl || req.url || ""
        });
        return res.status(400).json({
          ok: false,
          error: `Arquivo muito grande. Envie imagens com ate ${maxMb}MB.`
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

function listarArquivosUploadRequest(req) {
  const arquivos = [];

  if (req?.file?.path) arquivos.push(req.file);
  arquivos.push(...listarArquivosUpload(req?.files || {}));

  return arquivos;
}

function removerArquivoUpload(file) {
  try {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch (e) {
    console.warn("[UPLOAD_CLEANUP] falha ao remover temporario", {
      field: file?.fieldname || "",
      path: file?.path || "",
      erro: e.message
    });
  }
}

function limparUploadsTemporarios(files = {}) {
  for (const file of listarArquivosUpload(files)) {
    removerArquivoUpload(file);
  }
}

function limparUploadsRequest(req) {
  for (const file of listarArquivosUploadRequest(req)) {
    removerArquivoUpload(file);
  }
}

const ORDER_CREATE_DEDUPE_TTL_MS = 30 * 1000;
const ORDER_IDEMPOTENCY_PAYLOAD_VERSION = 2;
const ORDER_PRE_SCENARIO_V2_COMPAT_PRODUCTS = new Set([
  "proximo_jogo",
  "jogador_escudo",
  "mascote_uniforme",
  "escalacao"
]);
const orderCreateDedupe = new Map();

function stableOrderJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(item => stableOrderJson(item)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableOrderJson(value[key])}`)
    .join(",")}}`;
}

function getRequestIdempotencyKey(req) {
  const headerKey =
    req.get("X-Idempotency-Key") ||
    req.get("Idempotency-Key") ||
    "";
  const bodyKey = req.body?.client_request_id || "";

  return normalizarClientRequestId(headerKey || bodyKey || "");
}

function getUploadedFilesLegacyFingerprint(files = {}) {
  return Object.entries(files || {})
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .flatMap(([field, values]) => {
      const list = Array.isArray(values) ? values : [values];
      return list
        .filter(Boolean)
        .map((file, index) => ({
          field,
          index,
          originalname: String(file.originalname || ""),
          mimetype: String(file.mimetype || ""),
          size: Number(file.size || 0)
        }));
    });
}

function hashUploadedFileBytes(file) {
  return uploadContentHash.hashUploadedFileBytes(file);
}

function groupUploadedFiles(files = {}) {
  return uploadContentHash.groupUploadedFiles(files);
}

function getUploadedFilesFingerprint(files = {}) {
  return uploadContentHash.getUploadedFilesFingerprint(files);
}

function getSemanticOrderFields(fields = {}) {
  const newModel = fields?.new_model && typeof fields.new_model === "object"
    ? fields.new_model
    : null;
  const cleanFields = newModel?.fields && typeof newModel.fields === "object" && !Array.isArray(newModel.fields)
    ? { ...newModel.fields }
    : null;

  if (cleanFields) delete cleanFields.scenario_source;

  return {
    ...fields,
    ...(newModel ? {
      new_model: {
        ...newModel,
        ...(cleanFields ? { fields: cleanFields } : {})
      }
    } : {})
  };
}

function getOrderIdempotencySemanticControls(req) {
  const isBatchItem = req.fotoJogosBatchItem === true;
  const assistenteLote = isBatchItem || req.body?.assistente_lote === true;

  return {
    modalidade_criacao: isBatchItem
      ? normalizarModalidadeCriacao(req.body?.modalidade_criacao)
      : MODALIDADE_CRIACAO_COM_SUPORTE,
    cupom_codigo: normalizarCupomCodigo(req.body?.cupom_codigo),
    assistente_lote: assistenteLote,
    batch_id: assistenteLote
      ? normalizarFotoJogosBatchId(req.body?.batch_id || "")
      : ""
  };
}

function hashOrderPayloadV2({ user, categoria, fields, controls, files }) {
  return crypto
    .createHash("sha256")
    .update(stableOrderJson({
      user,
      categoria,
      fields: getSemanticOrderFields(fields),
      controls,
      files
    }))
    .digest("hex");
}

function objectHasScenarioMetadata(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).some(key => String(key).toLowerCase().startsWith("scenario"));
}

function orderHasStoredScenarioMetadata(pedido = {}) {
  return [
    pedido,
    pedido?.fields,
    pedido?.new_model,
    pedido?.new_model?.fields
  ].some(objectHasScenarioMetadata);
}

function buildPreScenarioDefaultCompatibilityV2({
  categoria,
  user,
  fields,
  legacyFields,
  controls,
  files
}) {
  const product = resultScenarioRegistry.getProductDefinition(categoria);
  const scenarioFields = fields?.new_model?.fields;
  const legacyNewModel = legacyFields?.new_model;
  const legacyScenarioFields = legacyNewModel?.fields;
  const legacyScenarioKeys = legacyScenarioFields && typeof legacyScenarioFields === "object"
    ? Object.keys(legacyScenarioFields).filter(key =>
        String(key).toLowerCase().startsWith("scenario")
      )
    : [];
  const legacyScenarioId = legacyScenarioFields?.scenario_id;
  const eligible = !!(
    product &&
    ORDER_PRE_SCENARIO_V2_COMPAT_PRODUCTS.has(product.id) &&
    legacyFields &&
    typeof legacyFields === "object" &&
    scenarioFields &&
    scenarioFields.scenario_id === product.defaultScenarioId &&
    Number(scenarioFields.scenario_version || 0) === 1 &&
    ["default", "explicit"].includes(scenarioFields.scenario_source) &&
    !objectHasScenarioMetadata(legacyFields) &&
    !objectHasScenarioMetadata(legacyNewModel) &&
    legacyScenarioKeys.every(key => key === "scenario_id") &&
    (
      legacyScenarioId === undefined ||
      legacyScenarioId === product.defaultScenarioId
    )
  );

  if (!eligible) {
    return {
      eligible: false,
      productId: product?.id || "",
      payloadHash: ""
    };
  }

  const preScenarioFields = {
    ...legacyFields,
    new_model: {
      ...legacyNewModel,
      fields: {
        ...legacyScenarioFields
      }
    }
  };
  delete preScenarioFields.new_model.fields.scenario_id;

  return {
    eligible: true,
    productId: product.id,
    payloadHash: hashOrderPayloadV2({
      user,
      categoria,
      fields: preScenarioFields,
      controls,
      files
    })
  };
}

function buildOrderCreateDedupeMeta(req, categoria, whatsapp, fields, options = {}) {
  const userKey = String(whatsapp || req.user?.whatsapp || "").trim();
  const clientRequestId = getRequestIdempotencyKey(req);
  const filesFingerprint = getUploadedFilesFingerprint(req.files || {});
  const legacyFilesFingerprint = getUploadedFilesLegacyFingerprint(req.files || {});
  const controls = getOrderIdempotencySemanticControls(req);
  const payloadHash = hashOrderPayloadV2({
    user: userKey,
    categoria,
    fields,
    controls,
    files: filesFingerprint
  });
  const preScenarioDefaultCompatibilityV2 = buildPreScenarioDefaultCompatibilityV2({
    categoria,
    user: userKey,
    fields,
    legacyFields: options.legacyFields,
    controls,
    files: filesFingerprint
  });
  const legacyPayloadHash = crypto
    .createHash("sha256")
    .update(stableOrderJson({
      user: userKey,
      categoria,
      fields: options.legacyFields || fields,
      files: legacyFilesFingerprint
    }))
    .digest("hex");

  return {
    key: clientRequestId
      ? `pedido:${userKey}:${clientRequestId}`
      : `pedido:${userKey}:auto:${payloadHash}`,
    clientRequestId,
    payloadHash,
    payloadVersion: ORDER_IDEMPOTENCY_PAYLOAD_VERSION,
    preScenarioDefaultCompatibilityV2,
    legacyPayloadHash,
    filesFingerprint
  };
}

function cleanupOrderCreateDedupe(now = Date.now()) {
  for (const [key, entry] of orderCreateDedupe.entries()) {
    if (!entry || entry.expiresAt <= now) {
      if (entry?.watchdogTimer) clearTimeout(entry.watchdogTimer);
      orderCreateDedupe.delete(key);
    }
  }
}

function getOrderCreateDedupeEntry(key) {
  cleanupOrderCreateDedupe();

  const entry = orderCreateDedupe.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    if (entry.watchdogTimer) clearTimeout(entry.watchdogTimer);
    orderCreateDedupe.delete(key);
    return null;
  }

  return entry;
}

function beginOrderCreateDedupe(key, payloadHash) {
  const entry = {
    expiresAt: Date.now() + ORDER_CREATE_DEDUPE_TTL_MS,
    payloadHash: String(payloadHash || ""),
    responsePayload: null,
    settled: false,
    resolve: null,
    reject: null,
    watchdogTimer: null
  };

  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });
  entry.promise.catch(() => {});

  entry.watchdogTimer = setTimeout(() => {
    if (entry.settled) return;
    entry.settled = true;
    entry.reject(new Error("order_create_dedupe_timeout"));
    orderCreateDedupe.delete(key);
  }, ORDER_CREATE_DEDUPE_TTL_MS);

  orderCreateDedupe.set(key, entry);
  return entry;
}

function evaluatePersistentOrderReplay(pedido, dedupeMeta) {
  const storedHash = String(pedido?.idempotency_payload_hash || "").trim().toLowerCase();
  const storedVersion = Number(pedido?.idempotency_payload_hash_version || 0);

  if (storedVersion === ORDER_IDEMPOTENCY_PAYLOAD_VERSION) {
    if (storedHash && storedHash === dedupeMeta.payloadHash) {
      return { replay: true, mode: "v2" };
    }

    const compatibility = dedupeMeta?.preScenarioDefaultCompatibilityV2;
    const storedProduct = resultScenarioRegistry.getProductDefinition(
      pedido?.product_id || pedido?.categoria || pedido?.produto
    );
    if (
      compatibility?.eligible === true &&
      storedProduct?.id === compatibility.productId &&
      !orderHasStoredScenarioMetadata(pedido) &&
      storedHash &&
      storedHash === compatibility.payloadHash
    ) {
      return { replay: true, mode: "v2_pre_scenario_default_compat" };
    }

    return { conflict: true, reason: "payload_hash_mismatch_v2" };
  }

  // Fingerprints anteriores ao v2 nao comprovam os bytes reais do upload.
  // O cliente deve usar uma nova chave em vez de reutilizar uma chave legada.
  if (storedVersion > 0 && storedVersion !== ORDER_IDEMPOTENCY_PAYLOAD_VERSION) {
    return { conflict: true, reason: "payload_hash_version_unknown" };
  }

  return {
    conflict: true,
    reason: storedHash
      ? "legacy_payload_fingerprint_unverifiable"
      : "legacy_payload_hash_missing"
  };
}

function resolveOrderCreateDedupe(entry, payload) {
  if (!entry || entry.settled) return;

  entry.responsePayload = payload;
  entry.settled = true;
  if (entry.watchdogTimer) clearTimeout(entry.watchdogTimer);
  entry.resolve(payload);
}

function rejectOrderCreateDedupe(key, entry, error) {
  if (!entry || entry.settled) return;

  entry.settled = true;
  if (entry.watchdogTimer) clearTimeout(entry.watchdogTimer);
  entry.reject(error);
  orderCreateDedupe.delete(key);
}

function validarUploadsImagemSeguros(req, res, next) {
  const arquivos = listarArquivosUploadRequest(req);

  for (const file of arquivos) {
    const validacao = validarAssinaturaImagem(file);

    if (!validacao.ok) {
      console.warn("[UPLOAD_SIGNATURE_INVALID]", {
        field: file.fieldname || "",
        originalname: file.originalname || "",
        mimetype: file.mimetype || "",
        size: file.size || 0,
        url: req.originalUrl || req.url || "",
        erro: validacao.error
      });

      limparUploadsRequest(req);

      return res.status(400).json({
        ok: false,
        error: validacao.error || "Arquivo de imagem invalido. Envie PNG, JPG ou WEBP."
      });
    }

    file.detected_mimetype = validacao.mime;
    file.detected_ext = validacao.ext;
  }

  return next();
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

function normalizarValorAuditoriaHash(value) {
  if (Array.isArray(value)) return value.map(normalizarValorAuditoriaHash);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = normalizarValorAuditoriaHash(value[key]);
      return out;
    }, {});
  }
  return value === undefined ? null : value;
}

function resumirArquivosAuditoria(files = {}) {
  const campos = [];
  let quantidadeImagens = 0;
  const assinatura = {};

  Object.keys(files || {}).sort().forEach(field => {
    const lista = Array.isArray(files[field]) ? files[field].filter(Boolean) : [];
    if (!lista.length) return;
    campos.push(field);
    quantidadeImagens += lista.length;
    assinatura[field] = lista.map((file, index) => ({
      index,
      size: Number(file?.size || 0),
      mimetype: String(file?.detected_mimetype || file?.mimetype || "").toLowerCase(),
      sha256: String(file?.content_sha256 || "").toLowerCase()
    }));
  });

  return { campos, quantidadeImagens, assinatura };
}

function gerarAuditoriaGeracaoLegada({ categoria, fields = {}, files = {}, request = null }) {
  const produto = String(categoria || "").trim().toLowerCase();
  const contract = LEGACY_GENERATION_CONTRACTS[produto] || null;
  if (!contract) return null;

  const cleanFields = fields?.new_model?.fields && typeof fields.new_model.fields === "object"
    ? fields.new_model.fields
    : {};
  const scenarioId = String(cleanFields.scenario_id || "");
  const scenarioVersion = Number(cleanFields.scenario_version || 0) || 0;
  const scenarioSource = cleanFields.scenario_source === "explicit"
    ? "explicit"
    : (scenarioId ? "default" : "");
  const legacyFields = Object.keys(fields || {}).filter(key => {
    if (key === "new_model") return false;
    const value = fields[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
  const fileSummary = resumirArquivosAuditoria(files);
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizarValorAuditoriaHash({
      produto,
      fields: getSemanticOrderFields(fields),
      files:fileSummary.assinatura
    })))
    .digest("hex");
  const requestPath = String(request?.originalUrl || request?.url || "");

  return {
    origem: requestPath.includes("/me/time/jogos/criar-artes") ? "ia4tube_batch" : "produto_antigo",
    produto_equivalente: produto,
    rota_produto_antigo: contract.route,
    tipo_interno: contract.internalType,
    flyer_tipo: contract.flyerTipo,
    arquivo_prompt: contract.promptFile,
    prompt_sha256: contract.promptSha256,
    servico_criacao: "criarPedidoHandler",
    armazenamento_pedido: "orderService.createOrderDraft",
    pipeline_worker: "resultado_pipeline.py",
    funcao_prompt: "load_prompt_imagem",
    funcao_montagem_final: "resultado_pipeline.main",
    funcao_openai: "render_via_chatgpt_api",
    modelo_esperado: "gpt-image-2",
    parametros_esperados: {
      size:"1024x1536",
      quality:"medium",
      output_format:"jpeg"
    },
    campos_legacy_presentes: legacyFields.sort(),
    campos_estruturados_presentes: Object.keys(cleanFields).sort(),
    campos_arquivo_presentes: fileSummary.campos,
    quantidade_imagens: fileSummary.quantidadeImagens,
    arquivos_sha256: fileSummary.assinatura,
    scenario_id: scenarioId,
    scenario_version: scenarioVersion,
    scenario_source: scenarioSource,
    idempotency_payload_hash_version: ORDER_IDEMPOTENCY_PAYLOAD_VERSION,
    payload_sha256: payloadHash
  };
}

function registrarAuditoriaProdutoPedido({ categoria, fields, files, pedidoId, request }) {
  const audit = productAuditService.auditProductOrder({ categoria, fields, files });
  const entry = {
    ...audit,
    geracao: gerarAuditoriaGeracaoLegada({ categoria, fields, files, request }),
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

app.use(createHealthRouter({
  config: radarConfig,
  buildInfo,
  checkDatabase: () => checkDatabase(radarPool),
  getMigrationStatus: () => getMigrationStatus(radarPool)
}));
app.use(radarObservability.metricsRouter({
  enabled: radarConfig.metricsEnabled && radarConfig.metricsConfigured,
  token: radarConfig.metricsToken
}));
const resolveBaseRadarIdentity = createLegacyRadarIdentityResolver({
  getAccountRecord(authSubject) {
    return readClientes()[authSubject] || null;
  },
  ensureLegacyProfile(authSubject) {
    return ensurePerfilCliente(readClientes(), authSubject);
  }
});
const resolveRadarIdentity = resolveBaseRadarIdentity;
const radarAccountSynchronizer = radarPool
  ? createRadarAccountSynchronizer({
    repository: createRadarIdentityRepository({ pool: radarPool }),
    resolveIdentity: resolveBaseRadarIdentity,
    listAccounts: readClientes
  })
  : null;

async function reconcileRadarAccount(authSubject, requestId) {
  if (!radarAccountSynchronizer) return null;
  try {
    return await radarAccountSynchronizer.syncAuthSubject(authSubject, { requestId });
  } catch (error) {
    radarLogger.error?.("[RADAR_ACCOUNT_SYNC] reconciliation failed", {
      error: error?.name || "Error"
    });
    return null;
  }
}

async function runRadarAutomaticBackfill() {
  if (!radarAccountSynchronizer) return null;
  const counts = await radarAccountSynchronizer.backfill();
  radarLogger.info?.("[RADAR_ACCOUNT_SYNC] backfill completed", counts);
  return counts;
}

function resolveRadarMatchContact(reference) {
  const expected = String(reference || "").trim();
  if (!expected) return null;
  const clientes = readClientes();
  for (const [authSubject, account] of Object.entries(clientes)) {
    if (accountReference(account, authSubject) !== expected) continue;
    const raw = String(
      account?.whatsapp || account?.telefone || account?.celular || authSubject || ""
    ).trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      const international = digits.length <= 11 ? `55${digits}` : digits;
      return Object.freeze({ type: "whatsapp", value: `+${international}` });
    }
    const email = String(account?.email || "").trim().toLowerCase();
    if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Object.freeze({ type: "email", value: email });
    }
    return null;
  }
  return null;
}
app.use("/amistosos", createFriendliesRouter({ config: radarConfig }));
app.use("/amistosos", createFriendlySearchRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  resolvePublicProfiles: resolveRadarSearchPublicProfiles,
  logger: radarLogger
}));
const radarInvitationRouters = createInvitationRouters({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
});
const radarReputationRouters = createTeamReputationRouters({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
});
const radarModerationRouters = createRadarModerationRouters({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
});
app.use("/amistosos", radarInvitationRouters.invitationRouter);
app.use("/radar/times", radarReputationRouters.publicRouter);
app.use("/radar/times", createRadarWhatsappRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time", radarReputationRouters.privateRouter);
app.use("/admin/radar/moderacao", radarModerationRouters.adminRouter);
app.use("/me/time/amistosos", createMatchHistoryRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time/amistosos", createMatchResultRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time/amistosos", createMatchCenterRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  resolveContact: resolveRadarMatchContact,
  logger: radarLogger
}));
app.use("/me/time/amistosos", createMatchCommunicationRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time/amistosos", radarInvitationRouters.teamRouter);
app.use("/me/time/amistosos", radarModerationRouters.matchRouter);
app.use("/me/notificacoes", radarInvitationRouters.notificationRouter);
app.use("/me/time/radar", createRadarIdentityRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time/radar", radarModerationRouters.ownerRouter);
app.use("/me/time/perfil", createProfilePrintImportRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time/amistosos", createAvailabilityRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/me/time", createInstagramVerificationRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));
app.use("/admin/radar/verificacoes", createInstagramVerificationAdminRouter({
  config: radarConfig,
  auth,
  pool: radarPool,
  resolveIdentity: resolveRadarIdentity,
  logger: radarLogger
}));

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

app.post(
  "/auth/browser-handoff",
  requireAuthBrowserHandoffEnabled,
  requireAuthBrowserHandoffOrigin,
  auth,
  (req, res) => {
    const startedAt = Date.now();
    const userId = String(req.user?.whatsapp || "").trim();
    const sessionExpiresAt = Number(req.user?.exp || 0) * 1000;

    try {
      if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
        logAuthBrowserHandoff(req, {
          evento: "handoff_emissao_recusada",
          status: 401,
          motivo: "session_expired",
          duracaoMs: Date.now() - startedAt
        });
        return res.status(401).json({
          ok: false,
          error: "Sessao invalida para transferencia."
        });
      }

      const clientes = readClientes();
      const cliente = clientes[userId];

      if (!cliente || cliente.ativo !== true) {
        logAuthBrowserHandoff(req, {
          evento: "handoff_emissao_recusada",
          status: 403,
          motivo: "account_unavailable",
          duracaoMs: Date.now() - startedAt
        });
        return res.status(403).json({
          ok: false,
          error: "Conta indisponivel para transferencia."
        });
      }

      const issued = authBrowserHandoffs.issue({
        userId,
        ipAddress: getPreviewLimiterIp(req),
        sessionExpiresAt
      });

      if (!issued.ok && issued.reason === "rate_limited") {
        return authBrowserHandoffRateLimited(req, res, issued, {
          duracaoMs: Date.now() - startedAt
        });
      }

      if (!issued.ok && issued.reason === "session_expired") {
        logAuthBrowserHandoff(req, {
          evento: "handoff_emissao_recusada",
          status: 401,
          motivo: "session_expired",
          duracaoMs: Date.now() - startedAt
        });
        return res.status(401).json({
          ok: false,
          error: "Sessao invalida para transferencia."
        });
      }

      logAuthBrowserHandoff(req, {
        evento: "handoff_emitido",
        status: 201,
        duracaoMs: Date.now() - startedAt
      });
      return res.status(201).json({
        ok: true,
        handoff_code: issued.token,
        expires_in: Math.ceil(issued.expiresInMs / 1000)
      });
    } catch (error) {
      return authBrowserHandoffStoreFailure(req, res, error, {
        duracaoMs: Date.now() - startedAt
      });
    }
  }
);

app.post(
  "/auth/browser-handoff/redeem",
  requireAuthBrowserHandoffEnabled,
  requireAuthBrowserHandoffOrigin,
  async (req, res) => {
    const startedAt = Date.now();

    if (!req.is("application/json")) {
      logAuthBrowserHandoff(req, {
        evento: "handoff_resgate_recusado",
        status: 415,
        motivo: "invalid",
        duracaoMs: Date.now() - startedAt
      });
      return res.status(415).json({
        ok: false,
        error: "Envie o codigo em formato JSON."
      });
    }

    try {
      const redeemed = authBrowserHandoffs.redeem(req.body?.code, {
        ipAddress: getPreviewLimiterIp(req)
      });

      if (!redeemed.ok && redeemed.reason === "rate_limited") {
        return authBrowserHandoffRateLimited(req, res, redeemed, {
          duracaoMs: Date.now() - startedAt
        });
      }

      if (!redeemed.ok) {
        const gone = ["expired", "superseded", "used"].includes(redeemed.reason);
        const status = gone ? 410 : 400;
        logAuthBrowserHandoff(req, {
          evento: gone ? "handoff_indisponivel" : "handoff_resgate_recusado",
          status,
          motivo: redeemed.reason,
          duracaoMs: Date.now() - startedAt
        });
        return res.status(status).json({
          ok: false,
          error: gone
            ? "Esta transferencia expirou ou ja foi utilizada."
            : "Codigo de transferencia invalido.",
          codigo: redeemed.reason
        });
      }

      const userId = String(redeemed.record?.user_id || "").trim();
      const remainingSessionSeconds = Math.floor(
        (Number(redeemed.record?.session_expires_at || 0) - Date.now()) / 1000
      );

      if (!Number.isFinite(remainingSessionSeconds) || remainingSessionSeconds < 1) {
        logAuthBrowserHandoff(req, {
          evento: "handoff_indisponivel",
          status: 410,
          motivo: "session_expired",
          idadeMs: redeemed.ageMs,
          duracaoMs: Date.now() - startedAt
        });
        return res.status(410).json({
          ok: false,
          error: "Esta transferencia expirou.",
          codigo: "session_expired"
        });
      }

      const clientes = readClientes();
      const cliente = clientes[userId];

      if (!cliente || cliente.ativo !== true) {
        logAuthBrowserHandoff(req, {
          evento: "handoff_resgate_recusado",
          status: 403,
          motivo: "account_unavailable",
          idadeMs: redeemed.ageMs,
          duracaoMs: Date.now() - startedAt
        });
        return res.status(403).json({
          ok: false,
          error: "Conta indisponivel para transferencia."
        });
      }

      const token = jwt.sign(
        { whatsapp: userId },
        JWT_SECRET,
        { expiresIn: remainingSessionSeconds }
      );
      const saldoInfo = billingService.getBalanceFields(cliente);
      await reconcileRadarAccount(userId, "auth-browser-handoff-redeem");

      logAuthBrowserHandoff(req, {
        evento: "handoff_resgatado",
        status: 200,
        idadeMs: redeemed.ageMs,
        duracaoMs: Date.now() - startedAt
      });
      return res.json({
        ok: true,
        token,
        whatsapp: userId,
        nome_time: cliente.nome_time,
        plano: cliente.plano,
        conta_auto_pendente: cliente.cadastro_automatico === true && cliente.conta_finalizada !== true,
        ...saldoInfo,
        usados_no_ciclo: Number(cliente.usados_no_ciclo || 0)
      });
    } catch (error) {
      return authBrowserHandoffStoreFailure(req, res, error, {
        duracaoMs: Date.now() - startedAt
      });
    }
  }
);

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
    const saldoInfo = billingService.getBalanceFields(c);
    await reconcileRadarAccount(chaveCliente, "auth-google");

    return res.json({
      ok: true,
      token,
      nome_time: c.nome_time,
      plano: c.plano,
      ...saldoInfo,
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
app.post("/auth/auto-register", async (req, res) => {
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
    await reconcileRadarAccount(login, "auth-auto-register");

    const token = jwt.sign({ whatsapp: login }, JWT_SECRET, { expiresIn: "7d" });
    const saldoInfo = billingService.getBalanceFields(novo);

    return res.json({
      ok: true,
      token,
      login,
      whatsapp: login,
      nome_time: novo.nome_time,
      plano: novo.plano,
      ...saldoInfo,
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
app.post("/auth/register", async (req, res) => {
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
  await reconcileRadarAccount(whatsapp, "auth-register");

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn: "7d" });
  const saldoInfo = billingService.getBalanceFields(novo);

  return res.json({
    ok: true,
    token,
    nome_time: novo.nome_time,
    plano: novo.plano,
    ...saldoInfo,
    usados_no_ciclo: novo.usados_no_ciclo
  });
});

app.post("/auth/finalizar-conta-auto", auth, async (req, res) => {
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
    await reconcileRadarAccount(novoLogin, "auth-finalizar-conta-auto");

    const token = jwt.sign({ whatsapp: novoLogin }, JWT_SECRET, { expiresIn: "7d" });
    const saldoInfo = billingService.getBalanceFields(clienteAtual);

    return res.json({
      ok:true,
      token,
      whatsapp: novoLogin,
      nome_time: clienteAtual.nome_time,
      plano: clienteAtual.plano,
      ...saldoInfo,
      usados_no_ciclo: clienteAtual.usados_no_ciclo
    });

  } catch (e) {
    return res.status(500).json({
      ok:false,
      error:"Erro ao finalizar conta automática"
    });
  }
});

app.post("/auth/login", async (req, res) => {
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
  const saldoInfo = billingService.getBalanceFields(c);
  await reconcileRadarAccount(whatsapp, "auth-login");

  return res.json({
    ok: true,
    token,
    nome_time: c.nome_time,
    plano: c.plano,
    ...saldoInfo,
    usados_no_ciclo: c.usados_no_ciclo
  });
});

// Perfil
app.get("/me", auth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
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

  const saldoInfo = billingService.getBalanceFields(c);

  return res.json({
    ok: true,
    perfil_id: perfilId,
    nome_time: c.nome_time,
    plano: c.plano,
    ...saldoInfo,
    usados_no_ciclo: c.usados_no_ciclo,
    brinde_mascote_disponivel: c.brinde_mascote_disponivel === true,
    brinde_escudo3d_app_disponivel: (
      c.brinde_escudo3d_app_usado !== true &&
      Number(c.usados_no_ciclo || 0) === 0 &&
      saldoInfo.saldo <= 0 &&
      c.brinde_mascote_ja_liberado !== true &&
      listPedidoBasesByWhatsapp(req.user.whatsapp).length === 0
    ),
    brinde_escudo3d_app_usado: c.brinde_escudo3d_app_usado === true,
    ativo: c.ativo
  });
});

app.post("/me/conta/exclusao", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "solicitou_exclusao_conta" });

  try {
    const whatsapp = req.user.whatsapp;
    const cliente = clienteResumoParaSolicitacao(whatsapp);

    if (!cliente.whatsapp) {
      return res.status(401).json({ ok: false, error: "Sessao invalida." });
    }

    const agora = new Date().toISOString();
    const solicitacoes = readJsonArraySafe(SOLICITACOES_EXCLUSAO_CONTA_FILE);
    const pendente = solicitacoes.find(item =>
      item &&
      item.cliente_id === cliente.cliente_id &&
      item.status === "pendente"
    );

    if (pendente) {
      pendente.atualizado_em = agora;
      pendente.motivo = textoLegalMultilinha(req.body?.motivo || pendente.motivo || "", 1000);
      pendente.origem = "app";
      writeJsonSafe(SOLICITACOES_EXCLUSAO_CONTA_FILE, solicitacoes);
      return res.json({
        ok: true,
        status: "pendente",
        solicitacao_id: pendente.id,
        mensagem: "Sua solicitacao de exclusao ja esta registrada."
      });
    }

    const solicitacao = {
      id: `exc_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      status: "pendente",
      origem: "app",
      cliente,
      cliente_id: cliente.cliente_id,
      motivo: textoLegalMultilinha(req.body?.motivo || "", 1000),
      criado_em: agora,
      atualizado_em: agora
    };

    solicitacoes.push(solicitacao);
    writeJsonSafe(SOLICITACOES_EXCLUSAO_CONTA_FILE, solicitacoes);

    return res.json({
      ok: true,
      status: "pendente",
      solicitacao_id: solicitacao.id,
      mensagem: "Solicitacao de exclusao registrada."
    });
  } catch (err) {
    console.warn("[conta_exclusao] falha ao registrar", {
      erro: err?.message || err
    });
    return res.status(500).json({
      ok: false,
      error: "Falha ao registrar solicitacao de exclusao."
    });
  }
});

app.post("/denuncias/conteudo-ia", authOpcional, (req, res) => {
  try {
    const body = req.body || {};
    const tipo = textoLegal(body.tipo || "conteudo_ia", 40);
    const motivo = textoLegal(body.motivo || "", 160);
    const descricao = textoLegalMultilinha(body.descricao || "", 2000);
    const url = urlLegal(body.url || body.link || "", 500);
    const contato = textoLegal(body.contato || "", 160);

    if (!motivo && !descricao) {
      return res.status(400).json({
        ok: false,
        error: "Informe o motivo da denuncia."
      });
    }

    const agora = new Date().toISOString();
    const denuncia = {
      id: `den_ia_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      status: "pendente",
      tipo,
      motivo,
      descricao,
      url,
      contato,
      cliente_id: req.user?.whatsapp || "",
      origem: "app",
      user_agent: textoLegal(req.headers["user-agent"] || "", 300),
      criado_em: agora,
      atualizado_em: agora
    };

    const denuncias = readJsonArraySafe(DENUNCIAS_CONTEUDO_IA_FILE);
    denuncias.push(denuncia);
    writeJsonSafe(DENUNCIAS_CONTEUDO_IA_FILE, denuncias);

    return res.json({
      ok: true,
      denuncia_id: denuncia.id,
      mensagem: "Denuncia registrada para analise."
    });
  } catch (err) {
    console.warn("[denuncia_ia] falha ao registrar", {
      erro: err?.message || err
    });
    return res.status(500).json({
      ok: false,
      error: "Falha ao registrar denuncia."
    });
  }
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
      slug: perfilAtual.slug,
      cidade: textoPerfil(body.cidade ?? perfilAtual.cidade),
      estado: textoPerfil(body.estado ?? perfilAtual.estado, 40),
      instagram: normalizarInstagramPerfil(body.instagram ?? perfilAtual.instagram),
      escudo_url: assetPerfil(body.escudo_url ?? perfilAtual.escudo_url),
      escudo_path: assetPerfil(body.escudo_path ?? perfilAtual.escudo_path),
      mascote_url: assetPerfil(body.mascote_url ?? perfilAtual.mascote_url),
      mascote_path: assetPerfil(body.mascote_path ?? perfilAtual.mascote_path),
      descricao_curta: textoPerfil(body.descricao_curta ?? perfilAtual.descricao_curta, 240),
      titulo_secao_resultados: textoPerfil(body.titulo_secao_resultados ?? perfilAtual.titulo_secao_resultados, 80),
      titulo_secao_proximo_jogo: textoPerfil(body.titulo_secao_proximo_jogo ?? perfilAtual.titulo_secao_proximo_jogo, 80),
      publico: body.publico === true,
      atualizado_em: agora
    }, perfilInfo.cliente, perfilInfo.perfil_id);

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

function caminhoImagemPerfilAtual(perfil, tipo) {
  const pathKey = `${tipo}_path`;
  const imagemPath = assetPerfil(perfil?.[pathKey] || "");
  if (!imagemPath) return "";
  if (path.isAbsolute(imagemPath)) return imagemPath;
  return path.join(getPerfilDir(perfil.perfil_id), imagemPath);
}

function servirImagemPerfilPrivada(req, res, tipo) {
  registrarOnline(req, { ultima_acao: `perfil_time_${tipo}_imagem` });

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const perfilAtual = safeReadJson(perfilInfo.perfil_file) || perfilInfo.perfil;
    const perfil = normalizarPerfilPrivado(perfilAtual, perfilInfo.cliente, perfilInfo.perfil_id);
    const imagemPath = caminhoImagemPerfilAtual(perfil, tipo);
    const perfilDir = getPerfilDir(perfilInfo.perfil_id);

    const perfilDirResolvido = path.resolve(perfilDir);
    const imagemResolvida = path.resolve(imagemPath || "");
    const dentroDaPastaPerfil = imagemResolvida === perfilDirResolvido || imagemResolvida.startsWith(perfilDirResolvido + path.sep);

    if (!imagemPath || !dentroDaPastaPerfil || !fs.existsSync(imagemResolvida)) {
      return res.status(404).json({ ok: false, error: "Imagem nao encontrada" });
    }

    return res.sendFile(imagemResolvida);
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar imagem do perfil"
    });
  }
}

function uploadImagemPerfilPrivada(tipo) {
  return (req, res) => {
    registrarOnline(req, { ultima_acao: `perfil_time_${tipo}_upload` });

    const imagem = req.file;

    if (!imagem || !imagem.path) {
      return res.status(400).json({ ok: false, error: "Envie uma imagem." });
    }

    const clientes = readClientes();

    try {
      const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
      const perfilAtual = safeReadJson(perfilInfo.perfil_file) || perfilInfo.perfil;
      const agora = new Date().toISOString();
      const validacaoImagem = validarAssinaturaImagemPerfil(imagem);
      const ext = validacaoImagem.ext;

      if (!validacaoImagem.ok || !ext) {
        limparUploadsTemporarios({ imagem: [imagem] });
        return res.status(400).json({ ok: false, error: validacaoImagem.error || "Formato de imagem invalido." });
      }

      const assetsDir = getPerfilAssetsDir(perfilInfo.perfil_id);
      ensureDir(assetsDir);

      const destino = getPerfilImagemFile(perfilInfo.perfil_id, tipo, ext);
      const antigos = [".png", ".jpg", ".jpeg", ".webp"]
        .map(oldExt => getPerfilImagemFile(perfilInfo.perfil_id, tipo, oldExt))
        .filter(filePath => filePath && filePath !== destino);

      fs.renameSync(imagem.path, destino);
      antigos.forEach(filePath => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          console.warn("[perfil_imagem] falha ao remover imagem antiga", {
            tipo,
            path: filePath,
            erro: e.message
          });
        }
      });

      const perfil = normalizarPerfilPrivado({
        ...perfilAtual,
        [`${tipo}_path`]: path.join("assets", `${tipo}${ext}`).replace(/\\/g, "/"),
        [`${tipo}_url`]: perfilImagemUrl(tipo),
        atualizado_em: agora
      }, perfilInfo.cliente, perfilInfo.perfil_id);

      perfil.atualizado_em = agora;

      writeJsonSafe(perfilInfo.perfil_file, perfil);

      return res.json({
        ok: true,
        perfil: perfilResponse(perfil),
        tipo,
        path: perfil[`${tipo}_path`],
        url: perfil[`${tipo}_url`]
      });
    } catch (err) {
      limparUploadsTemporarios({ imagem: [imagem] });

      const status = Number(err?.status || 500);

      return res.status(status).json({
        ok: false,
        error: status === 404 ? "Cliente nao encontrado" : "Falha ao salvar imagem do perfil"
      });
    }
  };
}

function perfilPublicoImagemUrl(perfil, tipo) {
  if (!perfil?.slug || !perfil?.[`${tipo}_path`]) return "";
  return `/time/${encodeURIComponent(perfil.slug)}/${tipo}/imagem`;
}

function perfilPublicoResponse(perfil) {
  return {
    slug: perfil.slug,
    nome_time: perfil.nome_time,
    cidade: perfil.cidade,
    estado: perfil.estado,
    instagram: perfil.instagram,
    escudo_url: perfilPublicoImagemUrl(perfil, "escudo"),
    mascote_url: perfilPublicoImagemUrl(perfil, "mascote"),
    descricao_curta: perfil.descricao_curta || "",
    titulo_secao_resultados: perfil.titulo_secao_resultados || "",
    titulo_secao_proximo_jogo: perfil.titulo_secao_proximo_jogo || ""
  };
}

function resolveRadarSearchPublicProfiles(slugs) {
  const wanted = new Set(
    (Array.isArray(slugs) ? slugs : [])
      .map(normalizarPerfilSlug)
      .filter(Boolean)
  );
  const profiles = new Map();
  if (wanted.size === 0 || !fs.existsSync(PERFIS_DIR)) return profiles;

  const entries = fs.readdirSync(PERFIS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (profiles.size === wanted.size) break;
    if (!entry.isDirectory()) continue;
    const profileId = normalizarPerfilId(entry.name);
    if (!profileId) continue;
    const current = safeReadJson(getPerfilFile(profileId));
    if (!current) continue;
    const profile = normalizarPerfilPrivado(current, { nome_time: current.nome_time }, profileId);
    if (profile.publico !== true || !wanted.has(profile.slug)) continue;
    profiles.set(profile.slug, Object.freeze({
      slug: profile.slug,
      name: profile.nome_time,
      public: true,
      hasCrest: Boolean(
        String(profile.escudo_path || "").trim() ||
        String(profile.escudo_url || "").trim()
      )
    }));
  }
  return profiles;
}

function rankingTimePublicoResponse(item) {
  return {
    slug: item.slug || "",
    nome_time: item.nome_time || "",
    cidade: item.cidade || "",
    estado: item.estado || "",
    escudo_url: item.escudo_url || "",
    estatisticas: item.estatisticas || calcularEstatisticasPerfil([]),
    artes_total: Number(item.artes_total || 0),
    pontos_atividade: Number(item.pontos_atividade || 0),
    perfil_completo_percentual: Number(item.perfil_completo_percentual || 0),
    jogadores_ativos: Number(item.jogadores_ativos || 0),
    patrocinadores_ativos: Number(item.patrocinadores_ativos || 0),
    divisoes_criadas: Number(item.divisoes_criadas || 0),
    votos_divisoes: Number(item.votos_divisoes || 0),
    ranking_motivo: item.ranking_motivo || ""
  };
}

function carregarPerfilPublicoPorSlug(slugParam) {
  const slug = normalizarPerfilSlug(slugParam);
  if (!slug || !fs.existsSync(PERFIS_DIR)) return null;

  const entries = fs.readdirSync(PERFIS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const perfilId = normalizarPerfilId(entry.name);
    if (!perfilId) continue;

    const perfilFile = getPerfilFile(perfilId);
    const perfilAtual = safeReadJson(perfilFile);
    if (!perfilAtual) continue;

    const perfil = normalizarPerfilPrivado(perfilAtual, { nome_time: perfilAtual.nome_time }, perfilId);
    if (perfil.publico === true && perfil.slug === slug) {
      return {
        perfil,
        perfil_id: perfilId,
        perfil_file: perfilFile,
        cliente_id: encontrarClienteIdPorPerfilId(perfilId)
      };
    }
  }

  return null;
}

function carregarPerfilTimePublico(req, res) {
  try {
    const perfilInfo = carregarPerfilPublicoPorSlug(req.params.slug);
    if (!perfilInfo) {
      return res.status(404).json({ ok: false, error: "Perfil publico nao encontrado" });
    }

    const jogadoresPrivados = readPerfilJogadores(perfilInfo.perfil_id)
      .filter(jogador => jogador && jogador.ativo !== false)
      .map(jogadorResponse);
    const jogadores = jogadoresPrivados.map(jogadorPublicoResponse);
    const jogosPrivados = readPerfilJogos(perfilInfo.perfil_id)
      .filter(jogo => jogo && jogo.ativo !== false)
      .map(jogoResponse);
    const jogos = jogosPrivados.map(jogoPublicoResponse);
    const escalacaoPrivada = readPerfilEscalacao(perfilInfo.perfil_id, jogadoresPrivados);
    const escalacaoPublicaItem = item => ({
      nome: item.nome || "",
      apelido: item.apelido || "",
      numero: item.numero || "",
      posicao: item.posicao || "",
      tipo: item.tipo || "",
      ordem: item.ordem || 0
    });
    const escalacao = {
      titulares: (escalacaoPrivada.titulares || []).map(escalacaoPublicaItem),
      reservas: (escalacaoPrivada.reservas || []).map(escalacaoPublicaItem)
    };
    const galeria = listarGaleriaPerfilCliente(perfilInfo.cliente_id, {
      perfilSlug: perfilInfo.perfil.slug,
      modo: "publico",
      limit: 50
    });
    const patrocinadores = readPerfilPatrocinadores(perfilInfo.perfil_id)
      .filter(patrocinador => patrocinador && patrocinador.ativo !== false)
      .map(patrocinador => patrocinadorPublicoResponse(patrocinador, perfilInfo.perfil.slug));

    return res.json({
      ok: true,
      perfil: perfilPublicoResponse(perfilInfo.perfil),
      jogadores,
      jogos,
      estatisticas: calcularEstatisticasPerfil(jogosPrivados),
      escalacao,
      galeria,
      patrocinadores
    });
  } catch (err) {
    console.warn("[perfil_publico] falha ao carregar", {
      slug: req.params.slug || "",
      erro: err?.message || err
    });

    return res.status(500).json({
      ok: false,
      error: "Falha ao carregar perfil publico"
    });
  }
}

function perfilTemImagem(perfil, tipo) {
  return !!(perfil?.[`${tipo}_url`] || perfil?.[`${tipo}_path`]);
}

function percentualPerfilCompleto(perfil) {
  const checks = [
    textoPerfil(perfil?.nome_time || ""),
    textoPerfil(perfil?.cidade || ""),
    textoPerfil(perfil?.estado || ""),
    textoPerfil(perfil?.instagram || ""),
    textoPerfil(perfil?.descricao_curta || ""),
    perfilTemImagem(perfil, "escudo"),
    perfilTemImagem(perfil, "mascote")
  ];
  const completos = checks.filter(Boolean).length;
  return Math.round((completos / checks.length) * 100);
}

function contarVotosDivisoes(divisoes = []) {
  return (Array.isArray(divisoes) ? divisoes : [])
    .reduce((total, sessao) => total + (Array.isArray(sessao?.votos) ? sessao.votos.length : 0), 0);
}

function motivoRankingAtividade({
  perfilCompletoPercentual = 0,
  jogadoresAtivos = 0,
  escalacaoTotal = 0,
  jogosTotal = 0,
  resultadosComPlacar = 0,
  patrocinadoresAtivos = 0,
  divisoesCriadas = 0,
  votosDivisoes = 0,
  artesTotal = 0,
  temEscudo = false,
  temMascote = false
} = {}) {
  const partes = [`perfil ${perfilCompletoPercentual}% completo`];

  if (jogadoresAtivos) partes.push(`${jogadoresAtivos} jogador(es) ativo(s)`);
  if (escalacaoTotal) partes.push("escalacao oficial cadastrada");
  if (jogosTotal) partes.push(`${jogosTotal} jogo(s) cadastrado(s)`);
  if (resultadosComPlacar) partes.push(`${resultadosComPlacar} resultado(s) com placar`);
  if (patrocinadoresAtivos) partes.push(`${patrocinadoresAtivos} patrocinador(es) ativo(s)`);
  if (divisoesCriadas) partes.push(`${divisoesCriadas} divisao(oes) criada(s)`);
  if (votosDivisoes) partes.push(`${votosDivisoes} voto(s) em divisoes`);
  if (artesTotal) partes.push(`${artesTotal} arte(s) na galeria`);
  if (temEscudo) partes.push("escudo cadastrado");
  if (temMascote) partes.push("mascote cadastrado");

  return partes.slice(0, 6).join(" · ");
}

function calcularAtividadeRankingTime({
  perfil,
  jogadores = [],
  escalacao = {},
  jogos = [],
  patrocinadores = [],
  divisoes = [],
  artesTotal = 0
} = {}) {
  const jogadoresAtivos = (Array.isArray(jogadores) ? jogadores : [])
    .filter(jogador => jogador && jogador.ativo !== false).length;
  const titulares = Array.isArray(escalacao?.titulares) ? escalacao.titulares.length : 0;
  const reservas = Array.isArray(escalacao?.reservas) ? escalacao.reservas.length : 0;
  const escalacaoTotal = titulares + reservas;
  const jogosAtivos = (Array.isArray(jogos) ? jogos : [])
    .filter(jogo => jogo && jogo.ativo !== false);
  const stats = calcularEstatisticasPerfil(jogosAtivos);
  const patrocinadoresAtivos = (Array.isArray(patrocinadores) ? patrocinadores : [])
    .filter(patrocinador => patrocinador && patrocinador.ativo !== false).length;
  const divisoesCriadas = (Array.isArray(divisoes) ? divisoes : []).length;
  const votosDivisoes = contarVotosDivisoes(divisoes);
  const temEscudo = perfilTemImagem(perfil, "escudo");
  const temMascote = perfilTemImagem(perfil, "mascote");
  const perfilCompletoPercentual = percentualPerfilCompleto(perfil);

  let pontos = 0;
  pontos += 10; // Todos os itens desta lista ja sao perfis publicos.
  pontos += Math.round(perfilCompletoPercentual / 5);
  if (temEscudo) pontos += 10;
  if (temMascote) pontos += 8;
  pontos += Math.min(jogadoresAtivos * 2, 24);
  pontos += Math.min(escalacaoTotal * 2, 18);
  pontos += Math.min(jogosAtivos.length * 3, 18);
  pontos += Math.min(stats.jogos * 6, 30);
  pontos += Math.min(patrocinadoresAtivos * 4, 16);
  pontos += Math.min(divisoesCriadas * 5, 20);
  pontos += Math.min(votosDivisoes * 2, 20);
  pontos += Math.min(Number(artesTotal || 0) * 5, 30);

  return {
    pontos_atividade: pontos,
    perfil_completo_percentual: perfilCompletoPercentual,
    jogadores_ativos: jogadoresAtivos,
    patrocinadores_ativos: patrocinadoresAtivos,
    divisoes_criadas: divisoesCriadas,
    votos_divisoes: votosDivisoes,
    ranking_motivo: motivoRankingAtividade({
      perfilCompletoPercentual,
      jogadoresAtivos,
      escalacaoTotal,
      jogosTotal: jogosAtivos.length,
      resultadosComPlacar: stats.jogos,
      patrocinadoresAtivos,
      divisoesCriadas,
      votosDivisoes,
      artesTotal: Number(artesTotal || 0),
      temEscudo,
      temMascote
    })
  };
}

function ordenarRankingTimes(lista, valorFn, desempateFn = null) {
  return [...lista]
    .sort((a, b) => {
      const valorDiff = Number(valorFn(b) || 0) - Number(valorFn(a) || 0);
      if (valorDiff) return valorDiff;

      if (typeof desempateFn === "function") {
        const desempateDiff = Number(desempateFn(b) || 0) - Number(desempateFn(a) || 0);
        if (desempateDiff) return desempateDiff;
      }

      return String(a.nome_time || "").localeCompare(String(b.nome_time || ""), "pt-BR");
    })
    .slice(0, 20)
    .map((item, index) => ({
      posicao: index + 1,
      ...item
    }));
}

function ordenarRankingAtividade(lista, limit = 20) {
  const ordenados = [...lista]
    .sort((a, b) => {
      const atividadeDiff = Number(b.pontos_atividade || 0) - Number(a.pontos_atividade || 0);
      if (atividadeDiff) return atividadeDiff;

      const vitoriasDiff = Number(b.estatisticas?.vitorias || 0) - Number(a.estatisticas?.vitorias || 0);
      if (vitoriasDiff) return vitoriasDiff;

      const aproveitamentoDiff = Number(b.estatisticas?.aproveitamento || 0) - Number(a.estatisticas?.aproveitamento || 0);
      if (aproveitamentoDiff) return aproveitamentoDiff;

      const golsDiff = Number(b.estatisticas?.gols_marcados || 0) - Number(a.estatisticas?.gols_marcados || 0);
      if (golsDiff) return golsDiff;

      const artesDiff = Number(b.artes_total || 0) - Number(a.artes_total || 0);
      if (artesDiff) return artesDiff;

      return String(a.nome_time || "").localeCompare(String(b.nome_time || ""), "pt-BR");
    });
  const limite = Number(limit || 0);
  const recorte = limite > 0 ? ordenados.slice(0, limite) : ordenados;

  return recorte
    .map((item, index) => ({
      posicao: index + 1,
      ...item
    }));
}

function carregarRankingTimes(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    ensureDir(PERFIS_DIR);

    const itens = [];
    const entradas = fs.readdirSync(PERFIS_DIR, { withFileTypes: true });

    for (const entrada of entradas) {
      if (!entrada.isDirectory()) continue;

      const perfilId = normalizarPerfilId(entrada.name);
      if (!perfilId) continue;

      const perfilFile = getPerfilFile(perfilId);
      const perfilAtual = safeReadJson(perfilFile);
      if (!perfilAtual) continue;

      const perfil = normalizarPerfilPrivado(perfilAtual, { nome_time: perfilAtual.nome_time }, perfilId);
      if (perfil.publico !== true || !perfil.slug) continue;

      const clienteId = encontrarClienteIdPorPerfilId(perfilId);
      const jogadores = readPerfilJogadores(perfilId);
      const escalacao = readPerfilEscalacao(perfilId, jogadores);
      const jogos = readPerfilJogos(perfilId)
        .filter(jogo => jogo && jogo.ativo !== false)
        .map(jogoResponse);
      const estatisticas = calcularEstatisticasPerfil(jogos);
      const patrocinadores = readPerfilPatrocinadores(perfilId);
      const divisoes = readPerfilDivisoes(perfilId);
      const artesTotal = clienteId ? contarArtesPerfilCliente(clienteId) : 0;
      const perfilPublico = perfilPublicoResponse(perfil);
      const atividade = calcularAtividadeRankingTime({
        perfil,
        jogadores,
        escalacao,
        jogos,
        patrocinadores,
        divisoes,
        artesTotal
      });

      itens.push(rankingTimePublicoResponse({
        slug: perfilPublico.slug,
        nome_time: perfilPublico.nome_time,
        cidade: perfilPublico.cidade || "",
        estado: perfilPublico.estado || "",
        escudo_url: perfilPublico.escudo_url || "",
        estatisticas,
        artes_total: artesTotal,
        ...atividade
      }));
    }

    const comJogos = itens.filter(item => Number(item.estatisticas?.jogos || 0) > 0);
    const timesOrdenados = ordenarRankingAtividade(itens, 0);
    const rankingAtividade = timesOrdenados.slice(0, 20);

    return res.json({
      ok: true,
      ranking_gerado_em: new Date().toISOString(),
      total_times: itens.length,
      times: timesOrdenados,
      rankings: {
        atividade: rankingAtividade,
        vitorias: ordenarRankingTimes(itens, item => item.estatisticas?.vitorias, item => item.estatisticas?.aproveitamento),
        gols_marcados: ordenarRankingTimes(itens, item => item.estatisticas?.gols_marcados, item => item.estatisticas?.vitorias),
        aproveitamento: ordenarRankingTimes(comJogos, item => item.estatisticas?.aproveitamento, item => item.estatisticas?.jogos),
        artes: ordenarRankingTimes(itens, item => item.artes_total, item => item.estatisticas?.vitorias)
      }
    });
  } catch (err) {
    console.warn("[ranking_times] falha ao carregar", {
      erro: err?.message || err
    });

    return res.status(500).json({
      ok: false,
      error: "Falha ao carregar ranking dos times"
    });
  }
}

function servirImagemPerfilPublica(req, res, tipo) {
  try {
    const perfilInfo = carregarPerfilPublicoPorSlug(req.params.slug);
    if (!perfilInfo) {
      return res.status(404).json({ ok: false, error: "Perfil publico nao encontrado" });
    }

    const imagemPath = caminhoImagemPerfilAtual(perfilInfo.perfil, tipo);
    const perfilDir = getPerfilDir(perfilInfo.perfil_id);
    const perfilDirResolvido = path.resolve(perfilDir);
    const imagemResolvida = path.resolve(imagemPath || "");
    const dentroDaPastaPerfil = imagemResolvida === perfilDirResolvido || imagemResolvida.startsWith(perfilDirResolvido + path.sep);

    if (!imagemPath || !dentroDaPastaPerfil || !fs.existsSync(imagemResolvida)) {
      return res.status(404).json({ ok: false, error: "Imagem nao encontrada" });
    }

    return res.sendFile(imagemResolvida);
  } catch (err) {
    console.warn("[perfil_publico] falha ao servir imagem", {
      slug: req.params.slug || "",
      tipo,
      erro: err?.message || err
    });

    return res.status(500).json({
      ok: false,
      error: "Falha ao carregar imagem do perfil"
    });
  }
}

function servirLogoPatrocinador(req, res, perfilId, patrocinadorId, { publico = false } = {}) {
  const patrocinadores = readPerfilPatrocinadores(perfilId);
  const id = normalizarPatrocinadorId(patrocinadorId);
  const patrocinador = patrocinadores.find(item => item.id === id);

  if (!patrocinador || (publico && patrocinador.ativo === false)) {
    return res.status(404).json({ ok: false, error: "Patrocinador nao encontrado" });
  }

  const logoPath = patrocinador.logo_path || "";
  const perfilDir = getPerfilDir(perfilId);
  const perfilDirResolvido = path.resolve(perfilDir);
  const logoResolvido = path.resolve(logoPath || "");
  const dentroDaPastaPerfil = logoResolvido === perfilDirResolvido || logoResolvido.startsWith(perfilDirResolvido + path.sep);

  if (!logoPath || !dentroDaPastaPerfil || !fs.existsSync(logoResolvido)) {
    return res.status(404).json({ ok: false, error: "Logo nao encontrado" });
  }

  if (patrocinador.logo_mime) {
    res.setHeader("Content-Type", patrocinador.logo_mime);
  }
  res.setHeader("Cache-Control", publico ? "public, max-age=300" : "private, no-store");

  return res.sendFile(logoResolvido);
}

function servirLogoPatrocinadorPublico(req, res) {
  try {
    const perfilInfo = carregarPerfilPublicoPorSlug(req.params.slug);
    if (!perfilInfo) {
      return res.status(404).json({ ok: false, error: "Perfil publico nao encontrado" });
    }

    return servirLogoPatrocinador(req, res, perfilInfo.perfil_id, req.params.id, { publico: true });
  } catch (err) {
    console.warn("[perfil_publico] falha ao servir logo patrocinador", {
      slug: req.params.slug || "",
      patrocinador_id: req.params.id || "",
      erro: err?.message || err
    });

    return res.status(500).json({ ok: false, error: "Falha ao carregar logo do patrocinador" });
  }
}

function servirImagemGaleriaPublica(req, res) {
  try {
    const perfilInfo = carregarPerfilPublicoPorSlug(req.params.slug);
    if (!perfilInfo || !perfilInfo.cliente_id) {
      return res.status(404).json({ ok: false, error: "Perfil publico nao encontrado" });
    }

    return servirImagemGaleriaPedido(req, res, perfilInfo.cliente_id, req.params.pedidoId);
  } catch (err) {
    console.warn("[perfil_publico] falha ao servir galeria", {
      slug: req.params.slug || "",
      pedido_id: req.params.pedidoId || "",
      erro: err?.message || err
    });

    return res.status(500).json({
      ok: false,
      error: "Falha ao carregar imagem da galeria"
    });
  }
}

app.get("/ranking/times", carregarRankingTimes);
app.get("/time/:slug", carregarPerfilTimePublico);
app.get("/time/:slug/escudo/imagem", (req, res) => servirImagemPerfilPublica(req, res, "escudo"));
app.get("/time/:slug/mascote/imagem", (req, res) => servirImagemPerfilPublica(req, res, "mascote"));
app.get("/time/:slug/galeria/:pedidoId/imagem", servirImagemGaleriaPublica);
app.get("/time/:slug/patrocinadores/:id/logo", servirLogoPatrocinadorPublico);

app.get("/me/perfil", auth, carregarPerfilTimePrivado);
app.patch("/me/perfil", auth, salvarPerfilTimePrivado);
app.get("/me/time/perfil", auth, carregarPerfilTimePrivado);
app.patch("/me/time/perfil", auth, salvarPerfilTimePrivado);
app.get("/me/time/perfil/escudo/imagem", auth, (req, res) => servirImagemPerfilPrivada(req, res, "escudo"));
app.get("/me/time/perfil/mascote/imagem", auth, (req, res) => servirImagemPerfilPrivada(req, res, "mascote"));
app.post("/me/time/perfil/escudo", auth, uploadComErroControlado(uploadPerfilImagem.single("imagem")), uploadImagemPerfilPrivada("escudo"));
app.post("/me/time/perfil/mascote", auth, uploadComErroControlado(uploadPerfilImagem.single("imagem")), uploadImagemPerfilPrivada("mascote"));

app.get("/me/time/galeria", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_galeria" });

  const clientes = readClientes();

  try {
    ensurePerfilCliente(clientes, req.user.whatsapp);
    const galeria = listarGaleriaPerfilCliente(req.user.whatsapp, {
      modo: "privado",
      limit: 50
    });

    return res.json({
      ok: true,
      limite: 50,
      galeria
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar galeria"
    });
  }
});

app.get("/me/time/galeria/:pedidoId/imagem", auth, (req, res) => {
  return servirImagemGaleriaPedido(req, res, req.user.whatsapp, req.params.pedidoId);
});

app.get("/me/time/patrocinadores", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_patrocinadores" });

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const patrocinadores = readPerfilPatrocinadores(perfilInfo.perfil_id)
      .map(patrocinador => patrocinadorResponse(patrocinador));

    return res.json({ ok: true, patrocinadores });
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar patrocinadores"
    });
  }
});

app.post("/me/time/patrocinadores", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_patrocinador_criar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const nome = textoPerfil(body.nome || "", 80);

  if (!nome) {
    return res.status(400).json({ ok: false, error: "Nome do patrocinador obrigatorio" });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const patrocinadores = readPerfilPatrocinadores(perfilInfo.perfil_id);
    const patrocinador = payloadPatrocinador({
      ...body,
      nome,
      ativo: body.ativo !== false
    }, {
      id: gerarPatrocinadorId(),
      ativo: true
    });

    patrocinadores.push(patrocinador);
    writePerfilPatrocinadores(perfilInfo.perfil_id, patrocinadores);

    return res.status(201).json({
      ok: true,
      patrocinador: patrocinadorResponse(patrocinador)
    });
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao criar patrocinador"
    });
  }
});

app.patch("/me/time/patrocinadores/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_patrocinador_editar" });

  const patrocinadorId = normalizarPatrocinadorId(req.params.id);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};

  if (!patrocinadorId) {
    return res.status(400).json({ ok: false, error: "Patrocinador invalido" });
  }

  if (Object.prototype.hasOwnProperty.call(body, "nome") && !textoPerfil(body.nome, 80)) {
    return res.status(400).json({ ok: false, error: "Nome do patrocinador obrigatorio" });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const patrocinadores = readPerfilPatrocinadores(perfilInfo.perfil_id);
    const index = patrocinadores.findIndex(item => item.id === patrocinadorId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Patrocinador nao encontrado" });
    }

    const patrocinador = payloadPatrocinador(body, patrocinadores[index]);
    patrocinador.id = patrocinadores[index].id;
    patrocinador.criado_em = patrocinadores[index].criado_em;
    patrocinadores[index] = patrocinador;
    writePerfilPatrocinadores(perfilInfo.perfil_id, patrocinadores);

    return res.json({
      ok: true,
      patrocinador: patrocinadorResponse(patrocinador)
    });
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao editar patrocinador"
    });
  }
});

app.delete("/me/time/patrocinadores/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_patrocinador_remover" });

  const patrocinadorId = normalizarPatrocinadorId(req.params.id);

  if (!patrocinadorId) {
    return res.status(400).json({ ok: false, error: "Patrocinador invalido" });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const patrocinadores = readPerfilPatrocinadores(perfilInfo.perfil_id);
    const index = patrocinadores.findIndex(item => item.id === patrocinadorId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Patrocinador nao encontrado" });
    }

    patrocinadores[index] = {
      ...patrocinadores[index],
      ativo: false,
      atualizado_em: new Date().toISOString()
    };
    writePerfilPatrocinadores(perfilInfo.perfil_id, patrocinadores);

    return res.json({
      ok: true,
      patrocinador: patrocinadorResponse(patrocinadores[index])
    });
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao remover patrocinador"
    });
  }
});

app.get("/me/time/patrocinadores/:id/logo", auth, (req, res) => {
  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    return servirLogoPatrocinador(req, res, perfilInfo.perfil_id, req.params.id);
  } catch (err) {
    const status = Number(err?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar logo"
    });
  }
});

app.post("/me/time/patrocinadores/:id/logo", auth, uploadComErroControlado(uploadPerfilImagem.single("logo")), (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_patrocinador_logo" });

  const patrocinadorId = normalizarPatrocinadorId(req.params.id);
  const logo = req.file || null;

  if (!patrocinadorId) {
    limparUploadsTemporarios({ logo: logo ? [logo] : [] });
    return res.status(400).json({ ok: false, error: "Patrocinador invalido" });
  }

  if (!logo) {
    return res.status(400).json({ ok: false, error: "Logo nao enviado" });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const patrocinadores = readPerfilPatrocinadores(perfilInfo.perfil_id);
    const index = patrocinadores.findIndex(item => item.id === patrocinadorId);

    if (index < 0) {
      limparUploadsTemporarios({ logo: [logo] });
      return res.status(404).json({ ok: false, error: "Patrocinador nao encontrado" });
    }

    const validacaoLogo = validarAssinaturaImagemPerfil(logo);
    const ext = validacaoLogo.ext;
    if (!validacaoLogo.ok || !ext) {
      limparUploadsTemporarios({ logo: [logo] });
      return res.status(400).json({ ok: false, error: validacaoLogo.error || "Formato de logo invalido" });
    }

    const assetsDir = getPerfilPatrocinadoresAssetsDir(perfilInfo.perfil_id);
    ensureDir(assetsDir);

    const destino = path.join(assetsDir, `${patrocinadorId}${ext}`);
    const destinoResolvido = path.resolve(destino);
    const assetsResolvido = path.resolve(assetsDir);

    if (!destinoResolvido.startsWith(assetsResolvido + path.sep)) {
      limparUploadsTemporarios({ logo: [logo] });
      return res.status(400).json({ ok: false, error: "Destino invalido" });
    }

    try {
      const antigo = patrocinadores[index].logo_path;
      if (antigo && path.resolve(antigo) !== destinoResolvido && fs.existsSync(antigo)) {
        fs.unlinkSync(antigo);
      }
    } catch {}

    if (fs.existsSync(destinoResolvido)) fs.unlinkSync(destinoResolvido);
    fs.renameSync(logo.path, destinoResolvido);

    patrocinadores[index] = {
      ...patrocinadores[index],
      logo_path: destinoResolvido,
      logo_mime: validacaoLogo.mime,
      atualizado_em: new Date().toISOString()
    };
    writePerfilPatrocinadores(perfilInfo.perfil_id, patrocinadores);

    return res.json({
      ok: true,
      patrocinador: patrocinadorResponse(patrocinadores[index])
    });
  } catch (err) {
    limparUploadsTemporarios({ logo: [logo] });
    const status = Number(err?.status || 500);
    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao salvar logo"
    });
  }
});

app.get("/me/time/escalacao", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_escalacao" });

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id);
    const escalacao = readPerfilEscalacao(perfilInfo.perfil_id, jogadores);
    writePerfilEscalacao(perfilInfo.perfil_id, escalacao);

    return res.json({
      ok: true,
      escalacao
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar escalacao"
    });
  }
});

app.patch("/me/time/escalacao", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_escalacao_salvar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id);
    const escalacao = normalizarEscalacaoPerfil({
      titulares: body.titulares,
      reservas: body.reservas,
      atualizado_em: new Date().toISOString()
    }, jogadores);

    writePerfilEscalacao(perfilInfo.perfil_id, escalacao);

    return res.json({
      ok: true,
      escalacao
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao salvar escalacao"
    });
  }
});

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
    writePerfilEscalacao(
      perfilInfo.perfil_id,
      readPerfilEscalacao(perfilInfo.perfil_id, jogadores)
    );

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
    writePerfilEscalacao(
      perfilInfo.perfil_id,
      readPerfilEscalacao(perfilInfo.perfil_id, jogadores)
    );

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

app.post("/me/time/divisoes", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_divisao_criar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const idsRecebidos = Array.isArray(body.jogadores_presentes)
    ? body.jogadores_presentes
    : Array.isArray(body.jogadores_ids)
      ? body.jogadores_ids
      : [];
  const jogadoresIds = [...new Set(idsRecebidos.map(normalizarJogadorId).filter(Boolean))];

  if (jogadoresIds.length < 2) {
    return res.status(400).json({
      ok: false,
      error: "Selecione pelo menos 2 jogadores presentes."
    });
  }

  if (jogadoresIds.length > 30) {
    return res.status(400).json({
      ok: false,
      error: "Selecione no maximo 30 jogadores no MVP."
    });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id).filter(jogador => jogador.ativo !== false);
    const jogadoresMap = new Map(jogadores.map(jogador => [jogador.id, jogador]));
    const presentes = jogadoresIds.map(id => jogadoresMap.get(id)).filter(Boolean);

    if (presentes.length !== jogadoresIds.length) {
      return res.status(400).json({
        ok: false,
        error: "Um ou mais jogadores selecionados nao existem no elenco ativo."
      });
    }

    let shareToken = gerarDivisaoShareToken();
    for (let tentativas = 0; tentativas < 5 && encontrarDivisaoPorToken(shareToken); tentativas += 1) {
      shareToken = gerarDivisaoShareToken();
    }

    const agora = new Date().toISOString();
    const sessao = normalizarDivisao({
      id: gerarDivisaoId(),
      perfil_id: perfilInfo.perfil_id,
      titulo: textoPerfil(body.titulo || "Dividir Times", 90) || "Dividir Times",
      status: "aberta",
      share_token: shareToken,
      jogadores_presentes: presentes.map(divisaoJogadorSnapshot),
      votos: [],
      resultado: null,
      criado_por: req.user.whatsapp || "",
      criado_em: agora,
      atualizado_em: agora
    });
    const divisoes = readPerfilDivisoes(perfilInfo.perfil_id);

    divisoes.push(sessao);
    writePerfilDivisoes(perfilInfo.perfil_id, divisoes);

    return res.status(201).json({
      ok: true,
      sessao: divisaoResponse(sessao),
      resultado: null
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : (err?.message || "Falha ao criar votacao")
    });
  }
});

app.get("/me/time/divisoes/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_divisao" });

  const divisaoId = normalizarDivisaoId(req.params.id);
  const clientes = readClientes();

  if (!divisaoId) {
    return res.status(400).json({ ok: false, error: "Votacao invalida" });
  }

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const divisoes = readPerfilDivisoes(perfilInfo.perfil_id);
    const sessao = divisoes.find(item => item.id === divisaoId);

    if (!sessao) {
      return res.status(404).json({ ok: false, error: "Votacao nao encontrada." });
    }

    return res.json({
      ok: true,
      sessao: divisaoResponse(sessao),
      resultado: sessao.resultado ? resultadoDivisaoResponse(sessao.resultado) : null
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar votacao"
    });
  }
});

app.post("/me/time/divisoes/:id/gerar-times", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_divisao_gerar_times" });

  const divisaoId = normalizarDivisaoId(req.params.id);
  const clientes = readClientes();

  if (!divisaoId) {
    return res.status(400).json({ ok: false, error: "Votacao invalida" });
  }

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const divisoes = readPerfilDivisoes(perfilInfo.perfil_id);
    const index = divisoes.findIndex(item => item.id === divisaoId);

    if (index < 0) {
      return res.status(404).json({ ok: false, error: "Votacao nao encontrada." });
    }

    const sessao = divisoes[index];
    const resultado = gerarResultadoDivisao(sessao);
    const atualizada = normalizarDivisao({
      ...sessao,
      resultado,
      atualizado_em: new Date().toISOString()
    });

    divisoes[index] = atualizada;
    writePerfilDivisoes(perfilInfo.perfil_id, divisoes);

    return res.json({
      ok: true,
      sessao: divisaoResponse(atualizada),
      resultado: resultadoDivisaoResponse(resultado)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: err?.message || "Falha ao gerar times"
    });
  }
});

app.get("/dividir-times/:token", auth, (req, res) => {
  const tokenSessao = normalizarDivisaoToken(req.params.token);

  if (!tokenSessao) {
    return res.status(404).json({ ok: false, error: "Votacao nao encontrada." });
  }

  try {
    const localizacao = encontrarDivisaoPorToken(tokenSessao);

    if (!localizacao) {
      return res.status(404).json({ ok: false, error: "Votacao nao encontrada." });
    }

    registrarOnline(req, { ultima_acao: "dividir_times_votacao" });

    const voterUserId = normalizarVotanteUsuarioDivisao(req.user?.whatsapp);
    const jaVotou = !!(voterUserId && localizacao.sessao.votos.some(voto => voto.voter_user_id === voterUserId));

    return res.json({
      ok: true,
      sessao: divisaoResponse(localizacao.sessao, { publico: true }),
      ja_votou: jaVotou
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Falha ao carregar votacao."
    });
  }
});

app.post("/dividir-times/:token/votos", auth, (req, res) => {
  const tokenSessao = normalizarDivisaoToken(req.params.token);

  if (!tokenSessao) {
    return res.status(404).json({ ok: false, error: "Votacao nao encontrada." });
  }

  try {
    const localizacao = encontrarDivisaoPorToken(tokenSessao);

    if (!localizacao) {
      return res.status(404).json({ ok: false, error: "Votacao nao encontrada." });
    }

    const sessao = localizacao.sessao;

    if (sessao.status !== "aberta") {
      return res.status(400).json({ ok: false, error: "Esta votacao nao esta aberta." });
    }

    registrarOnline(req, { ultima_acao: "dividir_times_votar" });

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const voterUserId = normalizarVotanteUsuarioDivisao(req.user?.whatsapp);
    const voterToken = textoPerfil(body.voter_token || "", 200);
    const voterHash = voterToken ? hashVoterTokenDivisao(voterToken) : "";

    if (!voterUserId) {
      return res.status(401).json({ ok: false, error: "Entre na sua conta ou crie um cadastro para votar." });
    }

    if (sessao.votos.some(voto => voto.voter_user_id === voterUserId)) {
      return res.status(409).json({ ok: false, error: "Esta conta ja votou nesta sessao." });
    }

    const ranking = normalizarRankingDivisao(body.ranking, sessao.jogadores_presentes);
    const voto = normalizarVotoDivisao({
      id: gerarDivisaoVotoId(),
      voter_user_id: voterUserId,
      voter_token_hash: voterHash,
      nome_votante: textoPerfil(body.nome_votante || req.user?.whatsapp || "", 80),
      ranking,
      ranking_bruto: ranking,
      criado_em: new Date().toISOString()
    });
    const atualizada = normalizarDivisao({
      ...sessao,
      votos: [...sessao.votos, voto],
      atualizado_em: new Date().toISOString()
    });

    localizacao.divisoes[localizacao.index] = atualizada;
    writePerfilDivisoes(localizacao.perfil_id, localizacao.divisoes);

    return res.status(201).json({
      ok: true,
      votos_count: atualizada.votos.length
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: err?.message || "Falha ao salvar voto."
    });
  }
});

app.post("/me/time/avaliacoes-jogadores", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_avaliacao_jogadores_criar" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
  const idsRecebidos = Array.isArray(body.jogadores_avaliados)
    ? body.jogadores_avaliados
    : Array.isArray(body.jogadores_ids)
      ? body.jogadores_ids
      : [];
  const jogadoresIds = [...new Set(idsRecebidos.map(normalizarJogadorId).filter(Boolean))];

  if (jogadoresIds.length < 1) {
    return res.status(400).json({
      ok: false,
      error: "Selecione pelo menos 1 jogador para avaliar."
    });
  }

  if (jogadoresIds.length > 30) {
    return res.status(400).json({
      ok: false,
      error: "Selecione no maximo 30 jogadores no MVP."
    });
  }

  const clientes = readClientes();

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const jogadores = readPerfilJogadores(perfilInfo.perfil_id).filter(jogador => jogador.ativo !== false);
    const jogadoresMap = new Map(jogadores.map(jogador => [jogador.id, jogador]));
    const selecionados = jogadoresIds.map(id => jogadoresMap.get(id)).filter(Boolean);

    if (selecionados.length !== jogadoresIds.length) {
      return res.status(400).json({
        ok: false,
        error: "Um ou mais jogadores selecionados nao existem no elenco ativo."
      });
    }

    let shareToken = gerarAvaliacaoJogadoresShareToken();
    for (let tentativas = 0; tentativas < 5 && encontrarAvaliacaoJogadoresPorToken(shareToken); tentativas += 1) {
      shareToken = gerarAvaliacaoJogadoresShareToken();
    }

    const agora = new Date().toISOString();
    const sessao = normalizarAvaliacaoJogadoresSessao({
      id: gerarAvaliacaoJogadoresId(),
      perfil_id: perfilInfo.perfil_id,
      titulo: textoPerfil(body.titulo || "Avaliar Jogadores", 90) || "Avaliar Jogadores",
      status: "aberta",
      share_token: shareToken,
      jogadores_avaliados: selecionados.map(avaliacaoJogadorSnapshot),
      votos: [],
      criado_por: req.user.whatsapp || "",
      criado_em: agora,
      atualizado_em: agora
    });
    const avaliacoes = readPerfilAvaliacoesJogadores(perfilInfo.perfil_id);

    avaliacoes.push(sessao);
    writePerfilAvaliacoesJogadores(perfilInfo.perfil_id, avaliacoes);

    return res.status(201).json({
      ok: true,
      sessao: avaliacaoJogadoresResponse(sessao)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : (err?.message || "Falha ao criar avaliacao")
    });
  }
});

app.get("/me/time/avaliacoes-jogadores/:id", auth, (req, res) => {
  registrarOnline(req, { ultima_acao: "perfil_time_avaliacao_jogadores" });

  const avaliacaoId = normalizarAvaliacaoJogadoresId(req.params.id);
  const clientes = readClientes();

  if (!avaliacaoId) {
    return res.status(400).json({ ok: false, error: "Avaliacao invalida" });
  }

  try {
    const perfilInfo = ensurePerfilCliente(clientes, req.user.whatsapp);
    const avaliacoes = readPerfilAvaliacoesJogadores(perfilInfo.perfil_id);
    const sessao = avaliacoes.find(item => item.id === avaliacaoId);

    if (!sessao) {
      return res.status(404).json({ ok: false, error: "Avaliacao nao encontrada." });
    }

    return res.json({
      ok: true,
      sessao: avaliacaoJogadoresResponse(sessao)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: status === 404 ? "Cliente nao encontrado" : "Falha ao carregar avaliacao"
    });
  }
});

app.get("/avaliar-jogadores/:token", auth, (req, res) => {
  const tokenSessao = normalizarAvaliacaoJogadoresToken(req.params.token);

  if (!tokenSessao) {
    return res.status(404).json({ ok: false, error: "Avaliacao nao encontrada." });
  }

  try {
    const localizacao = encontrarAvaliacaoJogadoresPorToken(tokenSessao);

    if (!localizacao) {
      return res.status(404).json({ ok: false, error: "Avaliacao nao encontrada." });
    }

    registrarOnline(req, { ultima_acao: "avaliacao_jogadores_votacao" });

    const voterUserId = normalizarVotanteUsuarioDivisao(req.user?.whatsapp);
    const jaAvaliou = !!(voterUserId && localizacao.sessao.votos.some(voto => voto.voter_user_id === voterUserId));

    return res.json({
      ok: true,
      sessao: avaliacaoJogadoresResponse(localizacao.sessao, { publico: true }),
      ja_avaliou: jaAvaliou
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Falha ao carregar avaliacao."
    });
  }
});

app.post("/avaliar-jogadores/:token/votos", auth, (req, res) => {
  const tokenSessao = normalizarAvaliacaoJogadoresToken(req.params.token);

  if (!tokenSessao) {
    return res.status(404).json({ ok: false, error: "Avaliacao nao encontrada." });
  }

  try {
    const localizacao = encontrarAvaliacaoJogadoresPorToken(tokenSessao);

    if (!localizacao) {
      return res.status(404).json({ ok: false, error: "Avaliacao nao encontrada." });
    }

    const sessao = localizacao.sessao;

    if (sessao.status !== "aberta") {
      return res.status(400).json({ ok: false, error: "Esta avaliacao nao esta aberta." });
    }

    registrarOnline(req, { ultima_acao: "avaliacao_jogadores_votar" });

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const voterUserId = normalizarVotanteUsuarioDivisao(req.user?.whatsapp);
    const voterToken = textoPerfil(body.voter_token || "", 200);
    const voterHash = voterToken ? hashVoterTokenAvaliacaoJogadores(voterToken) : "";

    if (!voterUserId) {
      return res.status(401).json({ ok: false, error: "Entre na sua conta ou crie um cadastro para votar." });
    }

    if (sessao.votos.some(voto => voto.voter_user_id === voterUserId)) {
      return res.status(409).json({ ok: false, error: "Esta conta ja avaliou esta sessao." });
    }

    const avaliacoes = normalizarAvaliacoesJogadoresPayload(body.avaliacoes, sessao.jogadores_avaliados);
    const voto = normalizarVotoAvaliacaoJogadores({
      id: gerarAvaliacaoJogadoresVotoId(),
      voter_user_id: voterUserId,
      voter_token_hash: voterHash,
      nome_votante: textoPerfil(body.nome_votante || req.user?.whatsapp || "", 80),
      avaliacoes,
      criado_em: new Date().toISOString()
    });
    const atualizada = normalizarAvaliacaoJogadoresSessao({
      ...sessao,
      votos: [...sessao.votos, voto],
      atualizado_em: new Date().toISOString()
    });

    localizacao.avaliacoes[localizacao.index] = atualizada;
    writePerfilAvaliacoesJogadores(localizacao.perfil_id, localizacao.avaliacoes);

    return res.status(201).json({
      ok: true,
      votos_count: atualizada.votos.length,
      resultados: calcularResultadosAvaliacaoJogadores(atualizada)
    });
  } catch (err) {
    const status = Number(err?.status || 500);

    return res.status(status).json({
      ok: false,
      error: err?.message || "Falha ao salvar avaliacao."
    });
  }
});

app.post("/me/time/jogos/identificar-por-foto", auth, uploadComErroControlado(upload.single("imagem")), async (req, res) => {
  const imagem = req.file;
  let rateLimitReserva = null;
  let analysisRequestId = "";

  try {
    if (!imagem) {
      return res.status(400).json({
        ok: false,
        error: "Envie uma imagem PNG, JPG ou WEBP."
      });
    }

    if (Number(imagem.size || 0) > FOTO_JOGOS_MAX_IMAGE_SIZE) {
      return res.status(400).json({
        ok: false,
        error: "Imagem muito grande. Envie uma imagem com ate 20MB."
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Identificacao indisponivel no momento. Tente novamente em instantes."
      });
    }

    analysisRequestId = normalizarFotoJogosAnalysisRequestId(
      req.get("X-Idempotency-Key") ||
      req.get("Idempotency-Key") ||
      req.body?.client_request_id ||
      ""
    );
    const analysisDedupeKey = buildFotoJogosAnalysisDedupeKey(req, analysisRequestId);
    const analysisImageHash = hashFotoJogosAnalysisImage(imagem);
    const analysisDedupe = getFotoJogosAnalysisDedupeEntry(analysisDedupeKey);

    if (analysisDedupe) {
      if (analysisDedupe.imageHash !== analysisImageHash) {
        const conflito = new Error("A chave desta análise já foi usada com outra imagem.");
        conflito.status = 409;
        throw conflito;
      }
      const jogos = await analysisDedupe.promise;
      return res.json({
        ok: true,
        jogos,
        analysis_request_id: analysisRequestId,
        idempotent_replay: true
      });
    }

    rateLimitReserva = reservarFotoJogosRateLimit(req);
    const analysisPromise = identificarJogosPorFotoOpenAI(imagem);
    beginFotoJogosAnalysisDedupe(analysisDedupeKey, analysisImageHash, analysisPromise);
    const jogos = await analysisPromise;
    finalizarFotoJogosRateLimit(rateLimitReserva, "success");
    rateLimitReserva = null;

    return res.json({
      ok: true,
      jogos,
      analysis_request_id: analysisRequestId,
      idempotent_replay: false
    });
  } catch (err) {
    if (rateLimitReserva) {
      finalizarFotoJogosRateLimit(rateLimitReserva, "failed");
      rateLimitReserva = null;
    }

    if (err?.rateLimit === true) {
      return res.status(429).json({
        ok: false,
        error: err.message
      });
    }

    const status = Number(err?.status || 500);
    const timeout = err?.timeout === true;
    const schemaError = err?.schemaError === true;

    console.warn("[IDENTIFICAR_JOGOS_FOTO_ERRO]", {
      status,
      timeout,
      schemaError,
      openaiStatus: err?.openaiStatus || "",
      message: err?.message || String(err)
    });

    return res.status(status).json({
      ok: false,
      error: timeout
        ? "Tempo esgotado ao analisar a imagem. Tente uma foto mais nitida ou menor."
        : schemaError
          ? "Resposta da IA4Tube fora do formato esperado."
          : err?.message || "Nao foi possivel analisar a imagem com a IA4Tube."
    });
  } finally {
    limparUploadsTemporarios({ imagem: imagem ? [imagem] : [] });
  }
});

app.post("/me/time/jogos/criar-artes", auth, uploadComErroControlado(orderUpload.any()), async (req, res) => {
  try {
    const batchId = normalizarFotoJogosBatchId(req.body?.batch_id || req.body?.batchId);
    const items = parseFotoJogosBatchItems(req.body || {});

    if (!batchId) {
      limparUploadsRequest(req);
      return res.status(400).json({
        ok: false,
        error: "Lote inv\u00e1lido.",
        batch_id: "",
        criados: [],
        falhas: []
      });
    }

    if (!items.length) {
      limparUploadsRequest(req);
      return res.status(400).json({
        ok: false,
        error: "Selecione pelo menos uma arte.",
        batch_id: batchId,
        criados: [],
        falhas: []
      });
    }

    if (items.length > FOTO_JOGOS_BATCH_MAX_ITEMS) {
      limparUploadsRequest(req);
      return res.status(400).json({
        ok: false,
        error: `Crie no m\u00e1ximo ${FOTO_JOGOS_BATCH_MAX_ITEMS} artes por vez neste MVP.`,
        batch_id: batchId,
        criados: [],
        falhas: items.map((item, index) => fotoJogosBatchFalha(index, item, "Limite do lote excedido."))
      });
    }

    const validacaoArquivos = validarFotoJogosBatchFileBindings(req.files || [], items);
    if (!validacaoArquivos.ok) {
      limparUploadsRequest(req);
      console.warn("[FOTO_JOGOS_BATCH_ARQUIVOS_INVALIDOS]", {
        usuario: mascararFotoJogosIdentificador(req.user?.whatsapp || ""),
        tipo: "file_binding",
        total_erros: validacaoArquivos.errors.length
      });
      return res.status(400).json({
        ok: false,
        error: "Arquivos do lote inv\u00e1lidos.",
        batch_id: batchId,
        criados: [],
        falhas: [{ index: -1, error: "Arquivos do lote inv\u00e1lidos." }]
      });
    }

    let batchPayloadHash;

    try {
      batchPayloadHash = buildFotoJogosBatchPayloadHash(req, batchId, items);
    } catch (error) {
      limparUploadsRequest(req);
      console.warn("[FOTO_JOGOS_BATCH_HASH_ERRO]", {
        usuario: mascararFotoJogosIdentificador(req.user?.whatsapp || ""),
        tipo: error?.code || "UPLOAD_HASH_FAILED"
      });
      return res.status(400).json({
        ok: false,
        code: "UPLOAD_HASH_FAILED",
        error: "Nao foi possivel validar os arquivos do lote.",
        batch_id: batchId,
        criados: [],
        falhas: []
      });
    }

    const dedupeKey = `foto-jogos-batch:${req.user.whatsapp}:${batchId}`;
    const dedupe = getFotoJogosBatchDedupeEntry(dedupeKey);
    if (dedupe) {
      limparUploadsRequest(req);

      if (dedupe.payloadHash !== batchPayloadHash) {
        return res.status(409).json({
          ok: false,
          code: "IDEMPOTENCY_CONFLICT",
          error: "Este batch_id ja foi usado com outro conteudo.",
          batch_id: batchId,
          criados: [],
          falhas: []
        });
      }

      const resultado = await dedupe.promise;
      return res.status(resultado.status || 200).json(resultado.payload || resultado);
    }

    const promise = processarFotoJogosCriarArtesBatch(req, batchId, items);
    beginFotoJogosBatchDedupe(dedupeKey, batchPayloadHash, promise);
    const resultado = await promise;
    return res.status(resultado.status || 200).json(resultado.payload || resultado);
  } catch (err) {
    limparUploadsRequest(req);
    console.warn("[FOTO_JOGOS_BATCH_ERRO]", {
      usuario: mascararFotoJogosIdentificador(req.user?.whatsapp || ""),
      tipo: err?.code || err?.name || "erro",
      message: err?.message || String(err)
    });
    return res.status(Number(err?.status || 500)).json({
      ok: false,
      error: "N\u00e3o foi poss\u00edvel criar as artes selecionadas.",
      criados: [],
      falhas: []
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
      jogos: jogos.map(jogoResponse),
      estatisticas: calcularEstatisticasPerfil(jogos)
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

      const validacaoImagem = validarAssinaturaImagem(req.file);
      if (!validacaoImagem.ok) {
        removerArquivoUpload(req.file);
        return res.status(400).json({
          ok: false,
          error: validacaoImagem.error || "Arquivo de imagem invalido. Envie PNG, JPG ou WEBP."
        });
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

app.post("/cartas-app/:id/download-ticket", auth, (req, res) => {
  const startedAt = Date.now();
  const cartaId = String(req.params.id || "");
  const validated = validateCartaDownload(req.user.whatsapp, cartaId);

  setPrivateDownloadHeaders(res);

  if (!validated.ok) {
    logDownloadTechnical(req, {
      evento: "ticket_recusado",
      recurso: "carta_imagem",
      pedidoId: cartaId,
      rota: "carta_ticket",
      status: validated.status,
      erro: "carta_indisponivel",
      duracaoMs: Date.now() - startedAt
    });
    return res.status(validated.status).json({ ok: false, error: validated.error });
  }

  const issued = downloadTickets.issue({
    resourceType: "carta_imagem",
    resourceId: cartaId,
    userId: req.user.whatsapp
  });

  logDownloadTechnical(req, {
    evento: "ticket_emitido",
    recurso: "carta_imagem",
    pedidoId: cartaId,
    rota: "carta_ticket",
    status: 200,
    duracaoMs: Date.now() - startedAt
  });

  return res.json({
    ok: true,
    ticket: issued.token,
    expires_in: Math.ceil(issued.expiresInMs / 1000),
    download_path: `/cartas-app/${encodeURIComponent(cartaId)}/download-direto`
  });
});

app.post("/cartas-app/:id/download-direto", (req, res) => {
  const startedAt = Date.now();
  const cartaId = String(req.params.id || "");
  const redeemed = downloadTickets.redeem(req.body?.ticket, {
    resourceType: "carta_imagem",
    resourceId: cartaId
  });

  setPrivateDownloadHeaders(res);

  if (!redeemed.ok) {
    return ticketErrorResponse(req, res, redeemed, {
      recurso: "carta_imagem",
      pedidoId: cartaId,
      rota: "carta_download_direto",
      duracaoMs: Date.now() - startedAt
    });
  }

  const validated = validateCartaDownload(redeemed.record.userId, cartaId);
  if (!validated.ok) {
    logDownloadTechnical(req, {
      evento: "download_recusado",
      recurso: "carta_imagem",
      pedidoId: cartaId,
      rota: "carta_download_direto",
      status: validated.status,
      erro: "carta_indisponivel",
      duracaoMs: Date.now() - startedAt
    });
    return res.status(validated.status).json({ ok: false, error: validated.error });
  }

  const mimeType = mimeTypeForImageFile(validated.arquivo);
  const extension = extensionForImageMime(mimeType);
  const filename = safeDownloadFilename(
    `${cartaId}_omascote${extension}`,
    `omascote${extension}`
  );

  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", attachmentContentDisposition(filename));
  res.on("finish", () => {
    logDownloadTechnical(req, {
      evento: "download_concluido_servidor",
      recurso: "carta_imagem",
      pedidoId: cartaId,
      rota: "carta_download_direto",
      status: res.statusCode,
      duracaoMs: Date.now() - startedAt
    });
  });
  return res.sendFile(validated.arquivo);
});

app.get("/cartas-app/:id/imagem", auth, (req, res) => {
  try {
    const carta = getCartaAppAtivaById(req.params.id);
    const imagemPath = String(carta?.imagem_path || "").trim();

    if (
      !carta ||
      !cartaAppPermitidaParaCliente(carta, req.user.whatsapp) ||
      !imagemPath
    ) {
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
    if (bloquearRecursoPagamentoNoApp(req, res)) return;

    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN não configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();

    if (!clientes[whatsapp]) {
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

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
      notification_url: `${PUBLIC_API_BASE_URL}/webhook/mercadopago`,
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
    if (bloquearRecursoPagamentoNoApp(req, res)) return;

    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "MP_ACCESS_TOKEN nÃ£o configurado" });
    }

    const { pacote } = req.body || {};
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();

    if (!clientes[whatsapp]) {
      return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
    }

    const pacotes = {
      saldo_800: { titulo: "Saldo IA4Tube Pix - pague R$8 e receba R$10", valor_pago: 8.00, credito: 10.00 },
      saldo_1800: { titulo: "Saldo IA4Tube Pix - pague R$18 e receba R$21", valor_pago: 18.00, credito: 21.00 },
      saldo_2800: { titulo: "Saldo IA4Tube Pix - pague R$28 e receba R$32", valor_pago: 28.00, credito: 32.00 },
      saldo_4800: { titulo: "Saldo IA4Tube Pix - pague R$48 e receba R$56", valor_pago: 48.00, credito: 56.00 }
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
      notification_url: `${PUBLIC_API_BASE_URL}/webhook/mercadopago`
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
    if (!validarAssinaturaWebhookMercadoPago(req)) {
      return res.status(401).json({
        ok: false,
        error: "Assinatura de webhook invalida."
      });
    }

    const body = req.body || {};
    const paymentId =
      body?.data?.id ||
      body?.id ||
      req.query?.["data.id"] ||
      req.query?.data_id ||
      req.query?.id;
    const tipoNotificacao = String(body?.type || req.query?.type || "").toLowerCase();
    const notificacaoOrder =
      tipoNotificacao === "order" ||
      String(paymentId || "").toUpperCase().startsWith("ORD");

    if (!paymentId) {
      return res.json({ ok: true });
    }

    if (notificacaoOrder) {
      registrarEventoMpOrdersV2("webhook_recebido", {
        order_id: String(paymentId),
        type: tipoNotificacao,
        payload_bruto_sanitizado: body,
        query_sanitizada: req.query || {},
        headers_sanitizados: {
          x_request_id: String(req.headers?.["x-request-id"] || ""),
          assinatura_presente: Boolean(req.headers?.["x-signature"]),
          user_agent: String(req.headers?.["user-agent"] || "").slice(0, 200)
        }
      });

      try {
        const resultado = await processarOrderV2(paymentId, {
          source: "webhook"
        });
        return res.json({
          ok: true,
          ignored: resultado.ignored === true,
          pending: resultado.pending === true,
          confirmed: resultado.confirmed === true,
          terminal: resultado.terminal === true,
          rejected: resultado.rejected === true,
          rejeitado: resultado.rejected === true,
          liberados: Number(resultado.liberados || 0),
          reason: resultado.reason || ""
        });
      } catch (error) {
        registrarEventoMpOrdersV2("webhook_falha_temporaria", {
          order_id: String(paymentId),
          code: error.code || "ERRO",
          retryable: error.retryable === true
        });
        return res.status(error.retryable === true ? 503 : 500).json({
          ok: false,
          retryable: error.retryable === true
        });
      }
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

    const recursoUrl = notificacaoOrder
      ? `https://api.mercadopago.com/v1/orders/${paymentId}`
      : `https://api.mercadopago.com/v1/payments/${paymentId}`;
    const r = await fetch(recursoUrl, {
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    const recursoMercadoPago = await r.json();
    const pagamento = notificacaoOrder
      ? normalizarOrderMercadoPagoComoPagamento(recursoMercadoPago)
      : recursoMercadoPago;

    if (!r.ok) {
      processados = readMpProcessados();
      delete processados[paymentId];
      writeMpProcessados(processados);

      return res.json({ ok: true, status: pagamento.status || "ignorado" });
    }

    if (pagamento.status !== "approved") {
      if (notificacaoOrder) {
        const referenciaPendente = extrairReferenciaExternaPedidoPix(
          pagamento.external_reference
        );
        const basePendente = referenciaPendente?.whatsapp && referenciaPendente?.pedido_id
          ? getPedidoBase(
              referenciaPendente.whatsapp,
              referenciaPendente.pedido_id
            )
          : null;
        const pedidoPathPendente = basePendente
          ? path.join(basePendente, "pedido.json")
          : "";
        const pedidoPendente = pedidoPathPendente
          ? safeReadJson(pedidoPathPendente)
          : null;

        if (
          pedidoPendente &&
          String(pedidoPendente.mp_order_id || "") === String(paymentId)
        ) {
          const statusOrder = String(
            recursoMercadoPago?.status || pagamento.status || "pending"
          ).toLowerCase();
          const statusTerminal = [
            "cancelled",
            "canceled",
            "expired",
            "failed",
            "rejected"
          ].includes(statusOrder);

          pedidoPendente.mp_order_status = statusOrder;
          pedidoPendente.mp_payment_status = statusTerminal
            ? statusOrder
            : String(pagamento.status || statusOrder);
          pedidoPendente.pix_status_atualizado_em = new Date().toISOString();
          fs.writeFileSync(
            pedidoPathPendente,
            JSON.stringify(pedidoPendente, null, 2),
            "utf8"
          );
        }
      }

      processados = readMpProcessados();
      delete processados[paymentId];
      writeMpProcessados(processados);

      return res.json({ ok: true, status: pagamento.status || "ignorado" });
    }

    const external = String(pagamento.external_reference || "");
    const externalPartes = external.split("|");
    const referenciaPedidoPix = extrairReferenciaExternaPedidoPix(external);
    const tipo = pagamento.metadata?.tipo || referenciaPedidoPix?.tipo || (
      referenciaPedidoPix ? "pedido_pix" : ""
    );

    if (tipo === "pedido_pix_lote") {
      const whatsapp = referenciaPedidoPix?.whatsapp || "";
      const batchRef = referenciaPedidoPix?.batch_ref || "";
      const itens = whatsapp && batchRef
        ? listPedidoBasesByWhatsapp(whatsapp).filter(item =>
            item.pedido?.assistente_lote === true &&
            String(item.pedido?.pix_lote_ref || "") === batchRef &&
            item.pedido?.pagamento_pendente === true
          )
        : [];
      const batchId = String(itens[0]?.pedido?.batch_id || "");
      const valorDevido = normalizarValorFinanceiro(
        itens.reduce((total, item) => total + Number(item.pedido.valor_pendente || item.pedido.valor_final || 0), 0)
      );
      const valorAprovado = normalizarValorFinanceiro(pagamento.transaction_amount);
      const moedaAprovada = String(pagamento.currency_id || "BRL").toUpperCase();
      const idsDivergentes = itens.some(item =>
        String(item.pedido.mp_order_id || "") !== String(paymentId) ||
        (
          item.pedido.mp_payment_id &&
          pagamento.id &&
          String(item.pedido.mp_payment_id) !== String(pagamento.id)
        )
      );

      if (
        !whatsapp ||
        !batchRef ||
        !itens.length ||
        idsDivergentes ||
        valorDevido <= 0 ||
        valorAprovado <= 0 ||
        Math.abs(valorAprovado - valorDevido) >= 0.01 ||
        moedaAprovada !== "BRL"
      ) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix_lote",
          whatsapp,
          batch_id: batchId,
          status: "pagamento_divergente",
          valor_devido: valorDevido,
          valor_aprovado: valorAprovado,
          moeda: moedaAprovada,
          quantidade: itens.length,
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true, rejeitado: true });
      }

      const confirmadoEm = new Date().toISOString();
      for (const item of itens) {
        const pedido = item.pedido;
        pedido.pagamento_pendente = false;
        pedido.pagamento_metodo = "pix";
        pedido.pagamento_confirmado_em = confirmadoEm;
        pedido.mp_payment_status = "approved";
        pedido.mp_order_status = "processed";
        pedido.pagamento_info = {
          tipo: "pedido_pix_lote",
          status: pagamento.status || "",
          valor_pago: Number(pedido.valor_final || pedido.valor_pendente || 0),
          valor_lote: valorAprovado,
          quantidade_lote: itens.length,
          order_id: String(paymentId),
          payment_id: String(pagamento.id || paymentId),
          whatsapp,
          pedido_id: item.id,
          batch_id: batchId,
          modalidade_criacao: normalizarModalidadeCriacao(pedido.modalidade_criacao),
          confirmado_em: confirmadoEm
        };
        pedido.mensagens_cliente = Array.isArray(pedido.mensagens_cliente)
          ? pedido.mensagens_cliente
          : [];
        pedido.mensagens_cliente.push({
          id: `msg_pagamento_${paymentId}_${item.id}`,
          tipo: "pagamento_confirmado",
          titulo: "Pagamento confirmado ✅",
          texto: "Pagamento aprovado. Sua arte foi enviada para produção.",
          lida: false,
          payment_id: String(paymentId),
          criado_em: confirmadoEm
        });
        registrarUsoCupomPedido(pedido, whatsapp);
        writePedido(item.base, pedido);
        liberarPedidoEconomicoAposPagamento(item.base, pedido);
      }

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "pedido_pix_lote",
        whatsapp,
        batch_id: batchId,
        pedido_ids: itens.map(item => item.id),
        valor_aprovado: valorAprovado,
        status: pagamento.status,
        criado_em: confirmadoEm
      };
      writeMpProcessados(processados);
      return res.json({ ok: true, liberados: itens.length });
    }

    if (tipo === "pedido_pix") {
      const whatsapp =
        pagamento.metadata?.whatsapp ||
        referenciaPedidoPix?.whatsapp ||
        externalPartes[1];
      const pedidoId =
        pagamento.metadata?.pedido_id ||
        referenciaPedidoPix?.pedido_id ||
        externalPartes[2];

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

      const idPedidoMercadoPago = notificacaoOrder
        ? pedido.mp_order_id
        : pedido.mp_payment_id;
      const transacaoOrderDivergente =
        notificacaoOrder &&
        pedido.mp_payment_id &&
        pagamento.id &&
        String(pedido.mp_payment_id) !== String(pagamento.id);

      if (
        String(idPedidoMercadoPago || "") !== String(paymentId) ||
        transacaoOrderDivergente
      ) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: notificacaoOrder
            ? "order_id_divergente"
            : "payment_id_divergente",
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true });
      }

      const valorDevido = normalizarValorFinanceiro(pedido.valor_pendente || pedido.valor_final);
      const valorAprovado = normalizarValorFinanceiro(pagamento.transaction_amount);
      const moedaAprovada = String(pagamento.currency_id || "BRL").toUpperCase();
      const modalidadePedido = normalizarModalidadeCriacao(pedido.modalidade_criacao);
      const modalidadePagamentoInformada = String(
        pagamento.metadata?.modalidade_criacao ||
        (notificacaoOrder ? referenciaPedidoPix?.modalidade_criacao : "")
      ).trim().toLowerCase();
      const modalidadeDivergente =
        modalidadePagamentoInformada &&
        modalidadePagamentoInformada !== modalidadePedido;
      const valorDivergente =
        valorDevido <= 0 ||
        valorAprovado <= 0 ||
        Math.abs(valorAprovado - valorDevido) >= 0.01;

      if (valorDivergente || moedaAprovada !== "BRL" || modalidadeDivergente) {
        processados = readMpProcessados();
        processados[paymentId] = {
          tipo: "pedido_pix",
          whatsapp,
          pedido_id: pedidoId,
          status: "pagamento_divergente",
          valor_devido: valorDevido,
          valor_aprovado: valorAprovado,
          moeda: moedaAprovada,
          modalidade_pedido: modalidadePedido,
          modalidade_pagamento: modalidadePagamentoInformada,
          criado_em: new Date().toISOString()
        };
        writeMpProcessados(processados);
        return res.json({ ok: true, rejeitado: true });
      }

      const confirmadoEm = new Date().toISOString();
      const documentoNumero = String(pagamento.payer?.identification?.number || "").replace(/\D/g, "");
      const documentoFinal = documentoNumero ? documentoNumero.slice(-4) : "";

      pedido.pagamento_pendente = false;
      pedido.pagamento_metodo = "pix";
      pedido.pagamento_confirmado_em = confirmadoEm;
      pedido.mp_payment_status = "approved";
      if (notificacaoOrder) {
        pedido.mp_order_status = "processed";
      }
      pedido.pagamento_info = {
        tipo: "pedido_pix",
        status: pagamento.status || "",
        valor_pago: valorAprovado,
        order_id: notificacaoOrder ? String(paymentId) : "",
        payment_id: String(pagamento.id || paymentId),
        whatsapp: whatsapp,
        pedido_id: pedidoId,
        modalidade_criacao: modalidadePedido,
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
      liberarPedidoEconomicoAposPagamento(base, pedido);

      processados = readMpProcessados();
      processados[paymentId] = {
        tipo: "pedido_pix",
        whatsapp,
        pedido_id: pedidoId,
        modalidade_criacao: modalidadePedido,
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

    let scenarioContext;

    try {
      scenarioContext = buildOrderScenarioContext(categoria, req.body || {});
    } catch (error) {
      if (!String(error?.code || "").startsWith("SCENARIO_")) throw error;
      limparUploadsTemporarios(req.files);
      logOrderRequestEvent(req, "scenario_rejeitado", {
        categoria,
        status_code: Number(error.status || 400),
        scenario_id: error?.details?.scenario_id || "",
        scenario_version: Number(error?.details?.scenario_version || 0) || 0,
        scenario_source: error?.details?.scenario_source || "",
        detalhe: error.code
      });
      return res.status(Number(error.status || 400)).json(scenarioErrorPayload(error));
    }

    const { fields, legacyFields, resolution: scenarioResolution } = scenarioContext;
    const scenarioLogMeta = getScenarioLogMeta(scenarioResolution);
    const files = req.files || {};
    let dedupeMeta;

    try {
      dedupeMeta = buildOrderCreateDedupeMeta(req, categoria, whatsapp, fields, {
        legacyFields
      });
    } catch (error) {
      limparUploadsTemporarios(req.files);
      logOrderRequestEvent(req, "upload_hash_falhou", {
        categoria,
        status_code: 400,
        ...scenarioLogMeta,
        detalhe: error?.code || "UPLOAD_HASH_FAILED"
      });
      return res.status(400).json({
        ok: false,
        code: "UPLOAD_HASH_FAILED",
        error: "Nao foi possivel validar os arquivos enviados."
      });
    }

    if (dedupeMeta.clientRequestId) {
      const pedidoExistente = findPedidoByClientRequestId(whatsapp, dedupeMeta.clientRequestId);

      if (pedidoExistente) {
        const replayEvaluation = evaluatePersistentOrderReplay(
          pedidoExistente.pedido,
          dedupeMeta
        );
        limparUploadsTemporarios(req.files);

        if (replayEvaluation.conflict) {
          logOrderRequestEvent(req, "idempotency_conflito_persistente", {
            categoria,
            client_request_id: dedupeMeta.clientRequestId,
            pedido_id: pedidoExistente.id || pedidoExistente.pedido?.id || "",
            status_code: 409,
            ...scenarioLogMeta,
            idempotency_payload_hash: dedupeMeta.payloadHash,
            idempotency_payload_hash_version: dedupeMeta.payloadVersion,
            detalhe: replayEvaluation.reason
          });
          return res.status(409).json({
            ok: false,
            code: "IDEMPOTENCY_CONFLICT",
            error: "A chave deste pedido ja foi usada com outro conteudo."
          });
        }

        const payload = buildOrderResponsePayloadFromItem(pedidoExistente, {
          idempotent_replay: true,
          encontrado_por_client_request_id: true
        });

        logOrderRequestEvent(req, "idempotent_replay_persistente", {
          categoria,
          client_request_id: dedupeMeta.clientRequestId,
          pedido_id: payload.pedido_id,
          status_code: 200,
          idempotent_replay: true,
          ...scenarioLogMeta,
          idempotency_payload_hash: dedupeMeta.payloadHash,
          idempotency_payload_hash_version: dedupeMeta.payloadVersion,
          detalhe: replayEvaluation.mode
        });

        return res.json(payload);
      }
    }

    const existingDedupe = getOrderCreateDedupeEntry(dedupeMeta.key);

    if (existingDedupe) {
      limparUploadsTemporarios(req.files);

      if (existingDedupe.payloadHash !== dedupeMeta.payloadHash) {
        logOrderRequestEvent(req, "idempotency_conflito_em_memoria", {
          categoria,
          client_request_id: dedupeMeta.clientRequestId,
          status_code: 409,
          ...scenarioLogMeta,
          idempotency_payload_hash: dedupeMeta.payloadHash,
          idempotency_payload_hash_version: dedupeMeta.payloadVersion,
          detalhe: "payload_hash_mismatch_v2"
        });
        return res.status(409).json({
          ok: false,
          code: "IDEMPOTENCY_CONFLICT",
          error: "A chave deste pedido ja foi usada com outro conteudo."
        });
      }

      logOrderRequestEvent(req, "idempotent_replay_em_memoria", {
        categoria,
        client_request_id: dedupeMeta.clientRequestId,
        status_code: existingDedupe.responsePayload ? 200 : 202,
        idempotent_replay: true,
        ...scenarioLogMeta,
        idempotency_payload_hash: dedupeMeta.payloadHash,
        idempotency_payload_hash_version: dedupeMeta.payloadVersion
      });

      if (existingDedupe.responsePayload) {
        return res.json({
          ...existingDedupe.responsePayload,
          idempotent: true,
          idempotent_replay: true
        });
      }

      return existingDedupe.promise
        .then(payload => res.json({
          ...payload,
          idempotent: true,
          idempotent_replay: true
        }))
        .catch(() => res.status(409).json({
          ok: false,
          error: "Pedido duplicado ainda em confirmacao. Aguarde alguns segundos e confira Meus pedidos."
        }));
    }

    const mesAtual = nowYYYYMM();
    billingService.ensureCurrentBillingCycle(c, mesAtual);

    const temBrindeMascote = billingService.hasMascoteUniformeGift(categoria, c);
    const brindeEscudo3dApp = clienteElegivelBrindeEscudo3dApp(req, c, whatsapp, categoria);

    const modalidadeCriacao = req.fotoJogosBatchItem === true
      ? normalizarModalidadeCriacao(req.body?.modalidade_criacao)
      : MODALIDADE_CRIACAO_COM_SUPORTE;
    const custoPedidoComSuporte = getCustoPedido(categoria, c);
    const custoPedido = calcularCustoPedidoPorModalidade(custoPedidoComSuporte, modalidadeCriacao);
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

    const pedidoAssistente = req.fotoJogosBatchItem === true || req.body?.assistente_lote === true;
    const pagamentoAntecipadoObrigatorio =
      custoEfetivoPedido > 0 &&
      (pedidoAssistente || modalidadeCriacao === MODALIDADE_CRIACAO_ECONOMICA);
    const transacaoSaldoExistente = pagamentoAntecipadoObrigatorio
      ? null
      : findSaldoDebitTransaction(
        getClienteUserId(c, whatsapp),
        dedupeMeta.clientRequestId,
        custoEfetivoPedido
      );
    const temSaldoSuficiente =
      !pagamentoAntecipadoObrigatorio &&
      (billingService.hasEnoughBalance(c, custoEfetivoPedido) || !!transacaoSaldoExistente);

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

    let draft;
    const dedupeEntry = beginOrderCreateDedupe(dedupeMeta.key, dedupeMeta.payloadHash);

    try {
      draft = orderService.createOrderDraft({
        categoria,
        pedidosDir: PEDIDOS_DIR,
        whatsapp,
        mesAtual,
        fields,
        files,
        clientRequestId: dedupeMeta.clientRequestId,
        idempotencyKey: dedupeMeta.key,
        idempotencyPayloadHash: dedupeMeta.payloadHash,
        idempotencyPayloadHashVersion: dedupeMeta.payloadVersion,
        idempotencyInputFiles: dedupeMeta.filesFingerprint
      });
    } catch (e) {
      console.error("[pedido] erro ao criar pedido", {
        categoria,
        whatsapp,
        erro: e.message,
          code: e.code
      });

      rejectOrderCreateDedupe(dedupeMeta.key, dedupeEntry, e);

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
    draft.pedido.client_request_id = dedupeMeta.clientRequestId;
    draft.pedido.idempotency_key = dedupeMeta.key;
    draft.pedido.idempotency_payload_hash = dedupeMeta.payloadHash;
    draft.pedido.idempotency_payload_hash_version = dedupeMeta.payloadVersion;
    draft.pedido.idempotency_input_files = dedupeMeta.filesFingerprint;
    draft.pedido.modalidade_criacao = modalidadeCriacao;
    draft.pedido.assistente_lote = pedidoAssistente;
    draft.pedido.batch_id = pedidoAssistente
      ? normalizarFotoJogosBatchId(req.body?.batch_id || "")
      : "";
    draft.pedido.suporte_personalizado_incluido = modalidadeCriacao !== MODALIDADE_CRIACAO_ECONOMICA;
    draft.pedido.valor_com_suporte = normalizarValorFinanceiro(custoPedidoComSuporte);
    draft.pedido.valor_original = cupomAplicado
      ? normalizarValorFinanceiro(resultadoCupom.valorOriginal)
      : normalizarValorFinanceiro(custoPedido);
    draft.pedido.valor_desconto = cupomAplicado
      ? normalizarValorFinanceiro(resultadoCupom.desconto)
      : 0;
    draft.pedido.valor_final = normalizarValorFinanceiro(custoEfetivoPedido);
    registrarAuditoriaProdutoPedido({ categoria, fields, files, pedidoId: id, request:req });

    if (temSaldoSuficiente) {
      const saldoChargeInfo = aplicarCobrancaPedidoComLedger({
        cliente: c,
        whatsapp,
        pedidoId: id,
        clientRequestId: dedupeMeta.clientRequestId,
        custoPedido: custoEfetivoPedido,
        mesAtual,
        temBrindeMascote
      });

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
          origem: "desconto_automatico_criacao",
          client_request_id: dedupeMeta.clientRequestId,
          transacao_saldo_id: saldoChargeInfo?.transacao?.id || "",
          transacao_saldo_reutilizada: saldoChargeInfo?.reused === true
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
      draft.pedido.payment_flow_version = MP_ORDERS_V2_VERSION;
      draft.pedido.payment_flow_created_at = new Date().toISOString();
      draft.pedido.motivo_pagamento_pendente = pagamentoAntecipadoObrigatorio
        ? (pedidoAssistente ? "pix_obrigatorio_assistente" : "pix_obrigatorio_criacao_economica")
        : "saldo_insuficiente";
      aplicarResumoCupomNoPedido(draft.pedido, resultadoCupom);
      orderService.orderStorage.writeOrder(draft.base, draft.pedido);
      if (pagamentoAntecipadoObrigatorio) {
        writeOrderStatus(draft.base, "aguardando_pagamento");
      }
      registrarPreviewPendente({ identifiers: previewLimiterIdentifiers, whatsapp, pedidoId: id });
    }

    orderService.orderStorage.writeOrder(draft.base, draft.pedido);

    clientes[whatsapp] = c;
    writeClientes(clientes);

    if (cupomLockAtivo) {
      liberarLockCupomJogadorEscudo();
      cupomLockAtivo = false;
    }

    const responsePayload = {
      ok: true,
      pedido_id: id,
      pagamento_pendente: draft.pedido.pagamento_pendente === true,
      valor_pendente: Number(draft.pedido.valor_pendente || 0),
      cupom_aplicado: cupomAplicado,
      desconto: cupomAplicado ? resultadoCupom.resumo : null,
      valor_original: cupomAplicado ? resultadoCupom.valorOriginal : Number(custoPedido || 0),
      valor_desconto: cupomAplicado ? resultadoCupom.desconto : 0,
      valor_final: cupomAplicado ? resultadoCupom.valorFinal : Number(custoEfetivoPedido || 0),
      modalidade_criacao: modalidadeCriacao,
      requer_pix_antes_criacao: pagamentoAntecipadoObrigatorio,
      batch_id: draft.pedido.batch_id || "",
      assistente_lote: draft.pedido.assistente_lote === true,
      client_request_id: dedupeMeta.clientRequestId,
      ...scenarioLogMeta,
      mensagem: cupomAplicado
        ? `Cupom ${resultadoCupom.resumo.codigo} aplicado. Valor final: R$ ${resultadoCupom.valorFinal.toFixed(2).replace(".", ",")}.`
        : undefined
    };

    logOrderRequestEvent(req, "pedido_criado", {
      categoria,
      client_request_id: dedupeMeta.clientRequestId,
      pedido_id: id,
      status_code: 200,
      ...scenarioLogMeta,
      idempotency_payload_hash: dedupeMeta.payloadHash,
      idempotency_payload_hash_version: dedupeMeta.payloadVersion
    });

    resolveOrderCreateDedupe(dedupeEntry, responsePayload);

    return res.json(responsePayload);
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

app.get("/pedidos/por-client-request-id/:clientRequestId", auth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");

  const clientRequestId = normalizarClientRequestId(req.params.clientRequestId);

  if (!clientRequestId) {
    return res.status(400).json({
      ok: false,
      encontrado: false,
      error: "client_request_id invalido."
    });
  }

  const item = findPedidoByClientRequestId(req.user.whatsapp, clientRequestId);

  if (!item) {
    logOrderRequestEvent(req, "lookup_client_request_id_nao_encontrado", {
      client_request_id: clientRequestId,
      status_code: 200
    });

    return res.json({
      ok: true,
      encontrado: false
    });
  }

  const payload = buildOrderResponsePayloadFromItem(item, {
    encontrado: true,
    pedido: item.pedido || {},
    idempotent_replay: true,
    encontrado_por_client_request_id: true
  });

  logOrderRequestEvent(req, "lookup_client_request_id_encontrado", {
    client_request_id: clientRequestId,
    pedido_id: payload.pedido_id,
    status_code: 200,
    idempotent_replay: true
  });

  return res.json(payload);
});

app.post(
  "/pedidos",
  auth,
  uploadComErroControlado(orderUpload.fields([
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
  uploadComErroControlado(orderUpload.fields([
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
  uploadComErroControlado(orderUpload.fields([
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
        const pedido = readPedido(base);

        if (
          (statusPedido === "novo" || statusPedido === "ajuste_pendente") &&
          !pedidoEconomicoAguardandoPagamento(pedido)
        ) {
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

  if (pedidoEconomicoAguardandoPagamento(readPedido(base))) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento PIX pendente. O pedido economico ainda nao foi liberado para criacao."
    });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.zip"`);

  const archive = criarArquivoZip({ zlib: { level: 9 } });

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

  if (pedidoEconomicoAguardandoPagamento(readPedido(base))) {
    return res.status(403).json({
      ok: false,
      error: "Pagamento PIX pendente. O pedido economico ainda nao foi liberado."
    });
  }

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

    if (
      readOrderStatus(pdir, "") === "novo" &&
      !pedidoEconomicoAguardandoPagamento(readPedido(pdir))
    ) {
      pedidos.push({ id });
    }
  }

  return res.json({ ok: true, pedidos });
});

app.get("/meus-pedidos", auth, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  registrarOnline(req, { ultima_acao: "meus_pedidos" });

  const whatsapp = req.user.whatsapp;
  const clientes = readClientes();

  if (!clientes[whatsapp]) {
    return res.status(404).json({ ok: false, error: "Cliente nao encontrado" });
  }

  const itens = listPedidoBasesByWhatsapp(whatsapp);

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
      modalidade_criacao: normalizarModalidadeCriacao(item.pedido.modalidade_criacao),
      suporte_personalizado_incluido: normalizarModalidadeCriacao(item.pedido.modalidade_criacao) !== MODALIDADE_CRIACAO_ECONOMICA,
      valor_pendente: Number(item.pedido.valor_pendente || 0),
      valor_original: Number(item.pedido.valor_original || 0),
      valor_desconto: Number(item.pedido.valor_desconto || 0),
      valor_final: Number(item.pedido.valor_final || item.pedido.valor_pendente || 0),
      desconto_info: item.pedido.desconto_info || null,
      motivo_pagamento_pendente: item.pedido.motivo_pagamento_pendente || "",
      ajuste_automatico_usado: ajusteUsado,
      motivo_ajuste: item.pedido.motivo_ajuste || "",
      pode_baixar: imagemPronta && aprovadoCliente && !pagamentoPendente,
      pode_pedir_ajuste:
        normalizarModalidadeCriacao(item.pedido.modalidade_criacao) !== MODALIDADE_CRIACAO_ECONOMICA &&
        imagemPronta &&
        !aprovadoCliente &&
        !ajusteUsado &&
        status === "pronto"
    };
  });

  return res.json({ ok: true, pedidos });
});

app.post("/pedidos/:id/pagar-com-saldo", auth, (req, res) => {
  if (bloquearRecursoPagamentoNoApp(req, res)) return;

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

  const pagamentoRequestId = pedido.client_request_id || `pagamento_pendente_${req.params.id}`;
  const saldoChargeInfo = aplicarCobrancaPedidoComLedger({
    cliente: c,
    whatsapp,
    pedidoId: req.params.id,
    clientRequestId: pagamentoRequestId,
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
    confirmado_em: confirmadoEm,
    client_request_id: pagamentoRequestId,
    transacao_saldo_id: saldoChargeInfo?.transacao?.id || "",
    transacao_saldo_reutilizada: saldoChargeInfo?.reused === true
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
  liberarPedidoEconomicoAposPagamento(base, pedido);

  return res.json({
    ok: true,
    pagamento_pendente: false,
    modalidade_criacao: normalizarModalidadeCriacao(pedido.modalidade_criacao),
    valor_final: Number(pedido.valor_final || valorPendente)
  });
});

app.post("/pedidos/gerar-pix-lote", auth, async (req, res) => {
  try {
    if (bloquearRecursoPagamentoNoApp(req, res)) return;

    const whatsapp = req.user.whatsapp;
    const batchId = normalizarFotoJogosBatchId(req.body?.batch_id || "");
    if (!batchId) {
      return res.status(400).json({ ok: false, error: "Lote invalido." });
    }

    const itens = listPedidoBasesByWhatsapp(whatsapp)
      .filter(item =>
        item.pedido?.assistente_lote === true &&
        String(item.pedido?.batch_id || "") === batchId &&
        item.pedido?.pagamento_pendente === true
      );
    if (!itens.length) {
      return res.status(404).json({ ok: false, error: "Nenhum item pendente encontrado para este lote." });
    }
    const resultado = await criarOuReutilizarOrderV2({
      ownerId: whatsapp,
      flow: "batch",
      itens,
      batchId
    });

    return res.json({
      ok: true,
      batch_id: batchId,
      pedido_ids: itens.map(item => item.id),
      quantidade: itens.length,
      pix_copia_cola: resultado.pix.pix_copia_cola,
      qr_code_base64: resultado.pix.qr_code_base64,
      ticket_url: resultado.pix.ticket_url,
      order_id: resultado.pix.order_id,
      payment_id: resultado.pix.payment_id,
      valor_final: resultado.valor,
      valor_pendente: resultado.valor,
      payment_flow_version: MP_ORDERS_V2_VERSION,
      reused: resultado.reused === true
    });
  } catch (e) {
    return res.status(Number(e.status || 500)).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix do lote",
      code: e.code || "ERRO_PIX_LOTE",
      retryable: e.retryable === true
    });
  }
});

app.post("/pedidos/:id/gerar-pix", auth, async (req, res) => {
  try {
    if (bloquearRecursoPagamentoNoApp(req, res)) return;

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

    if (!pedidoUsaMpOrdersV2(pedido)) {
      return res.status(409).json({
        ok: false,
        error: "Este pedido foi criado antes do novo fluxo de pagamento e nao sera alterado automaticamente.",
        code: "PEDIDO_ANTERIOR_AO_V2"
      });
    }

    const resultado = await criarOuReutilizarOrderV2({
      ownerId: whatsapp,
      flow: "individual",
      itens: [{ id, base, pedido }]
    });

    return res.json({
      ok: true,
      pix_copia_cola: resultado.pix.pix_copia_cola,
      qr_code_base64: resultado.pix.qr_code_base64,
      ticket_url: resultado.pix.ticket_url,
      order_id: resultado.pix.order_id,
      payment_id: resultado.pix.payment_id,
      valor_pendente: Number(pedido.valor_pendente || 0),
      valor_original: Number(pedido.valor_original || 0),
      valor_desconto: Number(pedido.valor_desconto || 0),
      valor_final: Number(pedido.valor_final || pedido.valor_pendente || 0),
      modalidade_criacao: normalizarModalidadeCriacao(pedido.modalidade_criacao),
      desconto_info: pedido.desconto_info || null,
      payment_flow_version: MP_ORDERS_V2_VERSION,
      reused: resultado.reused === true
    });
  } catch (e) {
    return res.status(Number(e.status || 500)).json({
      ok: false,
      error: e.message || "Erro interno ao gerar Pix",
      code: e.code || "ERRO_PIX",
      retryable: e.retryable === true
    });
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
    modalidade_criacao: normalizarModalidadeCriacao(pedido.modalidade_criacao),
    desconto_info: pedido.desconto_info || null,
    order_id: pedido.mp_order_id || "",
    payment_id: pedido.mp_payment_id || "",
    mp_payment_status: pedido.mp_payment_status || "",
    pix_copia_cola: pedido.pix_copia_cola || "",
    qr_code_base64: pedido.pix_qr_code_base64 || "",
    ticket_url: pedido.pix_ticket_url || ""
  });
});

app.post("/pedidos/:id/aprovar", auth, async (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  await tentarRecuperarOrderV2Pedido(
    whatsapp,
    req.params.id,
    "cliente_aprovar"
  );

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
  const scenarioMeta = resultScenarioRegistry.getPedidoScenarioMeta(pedido);

  if (
    scenarioMeta.scenario_id &&
    resultScenarioRegistry.hasScenarioObservationConflict(motivo)
  ) {
    logOrderRequestEvent(req, "scenario_ajuste_rejeitado", {
      categoria: pedido.categoria || pedido.product_id || "",
      pedido_id: pedido.id || req.params.id,
      status_code: 422,
      ...scenarioMeta,
      detalhe: "SCENARIO_OBSERVATION_CONFLICT"
    });
    return res.status(422).json({
      ok: false,
      code: "SCENARIO_OBSERVATION_CONFLICT",
      error: "O ajuste nao pode pedir a troca de fundo ou cenario controlado pelo pedido.",
      scenario_id: scenarioMeta.scenario_id,
      scenario_version: scenarioMeta.scenario_version,
      scenario_source: scenarioMeta.scenario_source
    });
  }

  if (pedido.modalidade_criacao === MODALIDADE_CRIACAO_ECONOMICA) {
    return res.status(403).json({
      ok: false,
      error: "A cria\u00e7\u00e3o econ\u00f4mica n\u00e3o inclui pedidos de altera\u00e7\u00e3o ou atendimento personalizado. Em caso de falha t\u00e9cnica, fale com o suporte."
    });
  }

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

app.post("/pedidos/:id/download-ticket", auth, async (req, res) => {
  const startedAt = Date.now();
  const pedidoId = String(req.params.id || "");
  const formato = String(req.body?.formato || "resultado").toLowerCase();

  if (!["resultado", "zip"].includes(formato)) {
    return res.status(400).json({ ok: false, error: "Formato de download invalido." });
  }

  await tentarRecuperarOrderV2Pedido(
    req.user.whatsapp,
    pedidoId,
    "cliente_download"
  );

  const validated = validateOrderDownload(req.user.whatsapp, pedidoId, {
    requireResult: formato === "resultado"
  });

  setPrivateDownloadHeaders(res);

  if (!validated.ok) {
    logDownloadTechnical(req, {
      evento: "ticket_recusado",
      recurso: `pedido_${formato}`,
      pedidoId,
      rota: "pedido_ticket",
      status: validated.status,
      erro: "pedido_indisponivel",
      duracaoMs: Date.now() - startedAt
    });
    return res.status(validated.status).json({ ok: false, error: validated.error });
  }

  const resourceType = `pedido_${formato}`;
  const issued = downloadTickets.issue({
    resourceType,
    resourceId: pedidoId,
    userId: req.user.whatsapp
  });

  logDownloadTechnical(req, {
    evento: "ticket_emitido",
    recurso: resourceType,
    pedidoId,
    rota: "pedido_ticket",
    status: 200,
    duracaoMs: Date.now() - startedAt
  });

  return res.json({
    ok: true,
    ticket: issued.token,
    expires_in: Math.ceil(issued.expiresInMs / 1000),
    download_path: `/pedidos/${encodeURIComponent(pedidoId)}/download-direto/${formato}`
  });
});

app.post("/pedidos/:id/download-direto/:formato", (req, res) => {
  const startedAt = Date.now();
  const pedidoId = String(req.params.id || "");
  const formato = String(req.params.formato || "").toLowerCase();
  const resourceType = `pedido_${formato}`;

  setPrivateDownloadHeaders(res);

  if (!["resultado", "zip"].includes(formato)) {
    return res.status(404).json({ ok: false, error: "Download nao encontrado." });
  }

  const redeemed = downloadTickets.redeem(req.body?.ticket, {
    resourceType,
    resourceId: pedidoId
  });

  if (!redeemed.ok) {
    return ticketErrorResponse(req, res, redeemed, {
      recurso: resourceType,
      pedidoId,
      rota: "pedido_download_direto",
      duracaoMs: Date.now() - startedAt
    });
  }

  const validated = validateOrderDownload(redeemed.record.userId, pedidoId, {
    requireResult: formato === "resultado"
  });
  if (!validated.ok) {
    logDownloadTechnical(req, {
      evento: "download_recusado",
      recurso: resourceType,
      pedidoId,
      rota: "pedido_download_direto",
      status: validated.status,
      erro: "pedido_indisponivel",
      duracaoMs: Date.now() - startedAt
    });
    return res.status(validated.status).json({ ok: false, error: validated.error });
  }

  validated.pedido.baixado_cliente = true;
  validated.pedido.baixado_em = new Date().toISOString();
  try {
    fs.writeFileSync(
      validated.pedidoPath,
      JSON.stringify(validated.pedido, null, 2),
      "utf8"
    );
  } catch {}

  res.on("finish", () => {
    logDownloadTechnical(req, {
      evento: "download_concluido_servidor",
      recurso: resourceType,
      pedidoId,
      rota: "pedido_download_direto",
      status: res.statusCode,
      duracaoMs: Date.now() - startedAt
    });
  });

  if (formato === "zip") {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      attachmentContentDisposition(`${pedidoId}.zip`)
    );

    const archive = criarArquivoZip({ zlib: { level: 9 } });
    archive.on("error", err => {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Falha ao criar arquivo ZIP." });
      } else {
        res.end();
      }
      console.error("[download-zip]", err?.message || "erro_zip");
    });
    archive.pipe(res);
    archive.directory(validated.base, false);
    archive.finalize();
    return;
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader(
    "Content-Disposition",
    attachmentContentDisposition(`${pedidoId}_resultado.png`)
  );
  return res.sendFile(validated.arquivo);
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
    modalidade_criacao: normalizarModalidadeCriacao(pedido.modalidade_criacao),
    suporte_personalizado_incluido: normalizarModalidadeCriacao(pedido.modalidade_criacao) !== MODALIDADE_CRIACAO_ECONOMICA,
    valor_pendente: Number(pedido.valor_pendente || 0),
    valor_original: Number(pedido.valor_original || 0),
    valor_desconto: Number(pedido.valor_desconto || 0),
    valor_final: Number(pedido.valor_final || pedido.valor_pendente || 0),
    desconto_info: pedido.desconto_info || null,
    motivo_pagamento_pendente: pedido.motivo_pagamento_pendente || "",
    ajuste_automatico_usado: pedido.ajuste_automatico_usado === true,
    motivo_ajuste: pedido.motivo_ajuste || "",
    pode_baixar: imagem_pronta && pedido.aprovado_cliente === true && pedido.pagamento_pendente !== true,
    pode_pedir_ajuste:
      normalizarModalidadeCriacao(pedido.modalidade_criacao) !== MODALIDADE_CRIACAO_ECONOMICA &&
      imagem_pronta &&
      pedido.aprovado_cliente !== true &&
      pedido.ajuste_automatico_usado !== true &&
      status === "pronto"
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

  const archive = criarArquivoZip({ zlib: { level: 9 } });

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

    if (pedidoEconomicoAguardandoPagamento(readPedido(base))) {
      limparUploadsRequest(req);
      return res.status(403).json({
        ok: false,
        error: "Pagamento PIX pendente. O pedido economico ainda nao foi liberado."
      });
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

let profilePrintRetentionRunning = false;

async function runProfilePrintRetentionCleanup() {
  if (
    profilePrintRetentionRunning ||
    !radarPool ||
    !radarConfig.enabled ||
    !radarConfig.profilePrintImportEnabled
  ) return;

  profilePrintRetentionRunning = true;
  try {
    const repository = createProfilePrintImportRepository({ pool: radarPool });
    await repository.expireStale({ now: new Date(), limit: 500 });
  } catch (error) {
    console.error("[RADAR_PROFILE_PRINT_RETENTION] cleanup failed", {
      error: error?.name || "Error"
    });
  } finally {
    profilePrintRetentionRunning = false;
  }
}

if (require.main === module) {
  setInterval(finalizarConversasSuporteInativas, 60 * 1000);
  if (radarConfig.enabled && radarConfig.profilePrintImportEnabled && radarPool) {
    runProfilePrintRetentionCleanup();
    const retentionTimer = setInterval(
      runProfilePrintRetentionCleanup,
      radarConfig.profilePrintCleanupIntervalMs
    );
    retentionTimer.unref?.();
  }
  app.listen(PORT, () => {
    console.log("API rodando na porta", PORT);
    runRadarAutomaticBackfill().catch(error => {
      radarLogger.error?.("[RADAR_ACCOUNT_SYNC] backfill failed", {
        error: error?.name || "Error"
      });
    });
  });
}

module.exports = {
  app,
  __radarReleaseCandidate: {
    config: radarConfig,
    observabilitySnapshot: () => radarObservability.snapshot(),
    runAccountBackfill: runRadarAutomaticBackfill,
    closePool: async () => {
      if (radarPool) await radarPool.end();
    }
  },
  __fotoJogosTest: {
    schema: FOTO_JOGOS_JSON_SCHEMA,
    normalizarRespostaJogosFoto,
    formatarInformacoesEsportivasFotoJogo,
    identificarJogosPorFotoOpenAI,
    normalizarFotoJogosAnalysisRequestId,
    hashFotoJogosAnalysisImage,
    buildFotoJogosAnalysisDedupeKey,
    getFotoJogosAnalysisDedupeEntry,
    beginFotoJogosAnalysisDedupe,
    cleanupFotoJogosAnalysisDedupe,
    normalizarModalidadeCriacao,
    calcularCustoPedidoPorModalidade
  },
  __resultadoScenarioTest: {
    registry: resultScenarioRegistry,
    buildOrderScenarioContext,
    buildOrderResponsePayloadFromItem,
    buildOrderCreateDedupeMeta,
    buildFotoJogosBatchPayloadHash,
    evaluatePersistentOrderReplay,
    gerarAuditoriaGeracaoLegada,
    getSemanticOrderFields,
    getUploadedFilesFingerprint,
    stableOrderJson,
    resetDedupe() {
      for (const entry of orderCreateDedupe.values()) {
        if (entry?.watchdogTimer) clearTimeout(entry.watchdogTimer);
      }
      orderCreateDedupe.clear();
      fotoJogosBatchDedupe.clear();
    }
  },
  __mpOrdersV2Test: {
    version: MP_ORDERS_V2_VERSION,
    setHooks(hooks = {}) {
      mpOrdersV2TestHooks = hooks && typeof hooks === "object" ? hooks : {};
    },
    resetHooks() {
      mpOrdersV2TestHooks = {};
    },
    processarOrderV2
  }
};
