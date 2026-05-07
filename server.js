const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const archiver = require("archiver");

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
const EVENTOS_CLIENTES_FILE = path.join(DATA_DIR, "eventos_clientes.json");

// CORS: permite seu site chamar a API
app.use(cors({
  origin: ["https://omascote.com.br"],
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

// ===== HELPERS =====
function readClientes() {
  return JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8") || "{}");
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
if (categoria === "resultado") return 8.00;
if (categoria === "escalacao") return 8.00;
if (categoria === "contratacao") return 7.00;
if (categoria === "proximo_jogo") return 7.00;
if (categoria === "patrocinador") return 8.00;
if (categoria === "escudo3d") return 4.00;

if (categoria === "proximo_jogo_jogador") return 7.00;
if (categoria === "resultado_jogo_jogador") return 8.00;
if (categoria === "jogador_escudo") return 6.00;

return 0;
}


function nomeCategoriaPedido(categoria) {
  const nomes = {
    resultado: "Resultado do jogo",
    escalacao: "Escalação",
    contratacao: "Contratação",
    proximo_jogo: "Próximo jogo",
    patrocinador: "Patrocinador / Apoio",
    escudo3d: "Escudo 3D",
    proximo_jogo_jogador: "Próximo jogo jogador",
    resultado_jogo_jogador: "Resultado jogador",
    jogador_escudo: "Jogador + escudo"
  };

  return nomes[categoria] || categoria || "";
}

function nowYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function newPedidoId() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${mo}${da}_${hh}${mm}${ss}`;
}

function getPedidoBase(whatsapp, pedidoId) {
  const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);

  if (!fs.existsSync(pastaWhatsapp)) return null;

  const meses = fs.readdirSync(pastaWhatsapp);

  for (const mes of meses) {
    const base = path.join(pastaWhatsapp, mes, pedidoId);
    if (fs.existsSync(base)) return base;
  }

  return null;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isBotAdmin(req) {
  return req.user && req.user.whatsapp === BOT_ADMIN_WHATSAPP;
}

function getPedidoBaseGlobal(pedidoId) {
  if (!fs.existsSync(PEDIDOS_DIR)) return null;

  const whatsapps = fs.readdirSync(PEDIDOS_DIR);

  for (const whatsapp of whatsapps) {
    const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);
    if (!fs.existsSync(pastaWhatsapp) || !fs.statSync(pastaWhatsapp).isDirectory()) continue;

    const meses = fs.readdirSync(pastaWhatsapp);

    for (const mes of meses) {
      const base = path.join(pastaWhatsapp, mes, pedidoId);
      if (fs.existsSync(base)) return base;
    }
  }

  return null;
}

function listPedidoBasesByWhatsapp(whatsapp) {
  const pastaWhatsapp = path.join(PEDIDOS_DIR, whatsapp);

  if (!fs.existsSync(pastaWhatsapp)) return [];

  const meses = fs.readdirSync(pastaWhatsapp);
  const pedidos = [];

  for (const mes of meses) {
    const pastaMes = path.join(pastaWhatsapp, mes);
    if (!fs.existsSync(pastaMes) || !fs.statSync(pastaMes).isDirectory()) continue;

    const ids = fs.readdirSync(pastaMes);

    for (const id of ids) {
      const base = path.join(pastaMes, id);
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;

      const pedidoPath = path.join(base, "pedido.json");
      const pedido = safeReadJson(pedidoPath) || {};
      const criadoEm = pedido.criado_em || new Date(fs.statSync(base).mtimeMs).toISOString();

      pedidos.push({
        id,
        base,
        mes,
        pedido,
        criado_em: criadoEm
      });
    }
  }

  pedidos.sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
  return pedidos;
}

function removeOldPedidos(whatsapp, maxKeep = 15) {
  const pedidos = listPedidoBasesByWhatsapp(whatsapp);

  if (pedidos.length <= maxKeep) return;

  const excedentes = pedidos.slice(maxKeep);

  for (const item of excedentes) {
    try {
      fs.rmSync(item.base, { recursive: true, force: true });
    } catch {}
  }
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

function salvarEventosCliente(req, eventos = []) {
  try {
    if (!Array.isArray(eventos) || eventos.length === 0) return;

    const atuais = readJsonArraySafe(EVENTOS_CLIENTES_FILE);
    const agora = new Date().toISOString();

    const cliente = req.user ? getClienteResumo(req.user.whatsapp) : null;

    eventos.forEach(ev => {
      const payload = ev.p || {};
      const pedidoId = String(payload.pedido_id || ev.pedido_id || "").trim();

      const item = {
        data: agora,
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

      atuais.push(item);

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

    writeJsonSafe(EVENTOS_CLIENTES_FILE, atuais);
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
  }

  if (respostaIA && String(respostaIA).trim()) {
    conversa.mensagens.push({
      id: `${Date.now()}_${origem}`,
      data: new Date().toISOString(),
      autor: origem,
      texto: String(respostaIA || "").trim()
    });
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
const storage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, path.join(DATA_DIR, "tmp_uploads")),

  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({ storage });
const uploadResultado = multer({ storage });

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

// Login
app.post("/auth/register", (req, res) => {
  const { nome_time, whatsapp, senha } = req.body || {};

  if (!nome_time || !whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "nome_time, whatsapp e senha obrigatórios" });
  }

  const clientes = readClientes();

  if (clientes[whatsapp]) {
    return res.status(400).json({ ok: false, error: "Cliente já existe" });
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

  clientes[whatsapp] = novo;
  writeClientes(clientes);

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn: "7d" });

  return res.json({
    ok: true,
    token,
    nome_time: novo.nome_time,
    plano: novo.plano,
    usados_no_ciclo: novo.usados_no_ciclo
  });
});

app.post("/auth/login", (req, res) => {
  const { whatsapp, senha } = req.body || {};

  if (!whatsapp || !senha) {
    return res.status(400).json({ ok: false, error: "whatsapp e senha obrigatórios" });
  }

  const clientes = readClientes();
  const c = clientes[whatsapp];

  if (!c) {
    return res.status(401).json({ ok: false, error: "Cliente não encontrado" });
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

  return res.json({
    ok: true,
    nome_time: c.nome_time,
    plano: c.plano,
    saldo_mensal: Number(c.saldo_mensal || 0),
    saldo_extra: Number(c.saldo_extra || 0),
    saldo: Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0),
    usados_no_ciclo: c.usados_no_ciclo,
    ativo: c.ativo
  });
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

app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id || req.query?.id;

    if (!paymentId) {
      return res.json({ ok: true });
    }

    const processados = readMpProcessados();
    if (processados[paymentId]) {
      return res.json({ ok: true, duplicado: true });
    }

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    const pagamento = await r.json();

    if (!r.ok || pagamento.status !== "approved") {
      return res.json({ ok: true, status: pagamento.status || "ignorado" });
    }

    const external = String(pagamento.external_reference || "");
    const whatsapp = pagamento.metadata?.whatsapp || external.split("|")[0];
    const credito = Number(pagamento.metadata?.credito || 0);

    if (!whatsapp || !credito) {
      return res.json({ ok: true, error: "sem whatsapp ou credito" });
    }

    const clientes = readClientes();
    const c = clientes[whatsapp];

    if (!c) {
      return res.json({ ok: true, error: "cliente não encontrado" });
    }

    c.saldo_extra = Number(c.saldo_extra || 0) + credito;
    c.ativo = true;

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

    const mesAtual = nowYYYYMM();
    if (c.ciclo_mes !== mesAtual) {
      c.ciclo_mes = mesAtual;
      c.usados_no_ciclo = 0;
    }

    const custoPedido = getCustoPedido(categoria, c);
    const saldoTotal = Number(c.saldo_mensal || 0) + Number(c.saldo_extra || 0);

    if (saldoTotal < custoPedido) {
      clientes[whatsapp] = c;
      writeClientes(clientes);
      return res.status(403).json({
        ok: false,
        error: `Saldo insuficiente. Este pedido custa R$ ${custoPedido.toFixed(2).replace(".", ",")}`
      });
    }

    const {
  rodada,
  data,
  hora,
  arena,
  mascote_tipo,
  flyer_tipo,
  artilheiros,
  jogadores_json,
  jogadores_texto,
  time_principal,
  gols_time_principal,
  gols_adversario,
  time_adversario
} = req.body || {};
    if (!rodada || !data) {
      return res.status(400).json({
        ok: false,
        error: "rodada e data são obrigatórios"
      });
    }

    const id = newPedidoId();
    const base = path.join(PEDIDOS_DIR, whatsapp, mesAtual, id);

    ensureDir(base);

    const files = req.files || {};

    function moveOne(field, destName) {
      const f = files[field]?.[0];
      if (!f) return;
      const dest = path.join(base, destName);
      fs.renameSync(f.path, dest);
    }

    const podeUsarEscudo1 = ["resultado", "escalacao", "contratacao", "proximo_jogo", "patrocinador", "escudo3d", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo"].includes(categoria);
    const podeUsarEscudo2 = ["resultado", "escalacao", "contratacao", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria);
    const escudo2EhFotoJogador = false;
    const podeUsarMascote = ["resultado", "escalacao", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo"].includes(categoria);
    const podeUsarPatrocinadores = categoria === "patrocinador";

    if (podeUsarEscudo1) moveOne("escudo1", "escudo1.png");
    if (podeUsarEscudo2) moveOne("escudo2", "escudo2.png");
    if (escudo2EhFotoJogador) moveOne("escudo2", "mascote.png");
    if (podeUsarMascote) moveOne("mascote", "mascote.png");

    const pats = podeUsarPatrocinadores ? (files["patrocinadores"] || []) : [];

    pats.forEach((f, i) => {
      const dest = path.join(base, `pat${String(i + 1).padStart(2, "0")}.png`);
      fs.renameSync(f.path, dest);
    });

   const pedido = {
      time_principal: ["resultado", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria) ? (time_principal || "") : "",
      gols_time_principal: ["resultado", "resultado_jogo_jogador"].includes(categoria) ? (Number(gols_time_principal) || 0) : 0,
      gols_adversario: ["resultado", "resultado_jogo_jogador"].includes(categoria) ? (Number(gols_adversario) || 0) : 0,
      time_adversario: ["resultado", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria) ? (time_adversario || "") : "",
    
      artilheiros: categoria === "resultado" && artilheiros ? JSON.parse(artilheiros) : [],
      jogadores: ["escalacao", "jogador_escudo"].includes(categoria) && jogadores_json ? JSON.parse(jogadores_json) : [],
      jogadores_texto: ["escalacao", "jogador_escudo"].includes(categoria) ? (jogadores_texto || "") : "",
    
      escudo_principal: podeUsarEscudo1 && files["escudo1"]?.[0] ? "escudo1.png" : "",
      escudo_adversario: podeUsarEscudo2 && files["escudo2"]?.[0] ? "escudo2.png" : "",
      foto_jogo: ((podeUsarMascote && files["mascote"]?.[0]) || (escudo2EhFotoJogador && files["escudo2"]?.[0])) ? "mascote.png" : "",
    
      categoria: categoria,
      id,
      whatsapp,
      mes: mesAtual,
      rodada,
      data,
      hora: ["resultado", "resultado_jogo_jogador", "contratacao", "proximo_jogo", "proximo_jogo_jogador"].includes(categoria) ? (hora || "") : "",
      arena: ["proximo_jogo", "proximo_jogo_jogador"].includes(categoria) ? (arena || "") : "",
      mascote_tipo: mascote_tipo || "",
      patrocinadores_qtd: pats.length,
      status: "novo",
      criado_em: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(base, "pedido.json"),
      JSON.stringify(pedido, null, 2),
      "utf8"
    );

    fs.writeFileSync(path.join(base, "status.txt"), "novo", "utf8");

    let restante = custoPedido;

    const saldoExtraAtual = Number(c.saldo_extra || 0);
    const descontoExtra = Math.min(saldoExtraAtual, restante);
    c.saldo_extra = Number((saldoExtraAtual - descontoExtra).toFixed(2));
    restante = Number((restante - descontoExtra).toFixed(2));

    if (restante > 0) {
      const saldoMensalAtual = Number(c.saldo_mensal || 0);
      c.saldo_mensal = Number(Math.max(0, saldoMensalAtual - restante).toFixed(2));
    }

    c.usados_no_ciclo = (c.usados_no_ciclo || 0) + 1;
    c.ciclo_mes = mesAtual;

    clientes[whatsapp] = c;
    writeClientes(clientes);

    removeOldPedidos(whatsapp, 15);

    return res.json({ ok: true, pedido_id: id });
  };
}

// ===== CRIAR PEDIDO =====
app.post(
  "/pedidos",
  auth,
  upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 }
  ]),
  (req, res) => {
    const flyer_tipo = (req.body?.flyer_tipo || "").toLowerCase();

    if (flyer_tipo === "escudo3d") return criarPedidoHandler("escudo3d")(req, res);
    if (flyer_tipo === "zz1fs") return criarPedidoHandler("escalacao")(req, res);
    if (flyer_tipo === "zz1fm") return criarPedidoHandler("contratacao")(req, res);
    if (flyer_tipo === "zz1ft") return criarPedidoHandler("proximo_jogo")(req, res);
    if (flyer_tipo === "zz1fj") return criarPedidoHandler("patrocinador")(req, res);
    if (flyer_tipo === "jog_proximo") return criarPedidoHandler("proximo_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_resultado") return criarPedidoHandler("resultado_jogo_jogador")(req, res);
    if (flyer_tipo === "jog_escudo") return criarPedidoHandler("jogador_escudo")(req, res);

    return criarPedidoHandler("pedido")(req, res);
  }
);

app.post(
  "/mascotes",
  auth,
  upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 }
  ]),
  criarPedidoHandler("mascote")
);

app.post(
  "/resultado_do_jogo",
  auth,
  upload.fields([
    { name: "escudo1", maxCount: 1 },
    { name: "escudo2", maxCount: 1 },
    { name: "mascote", maxCount: 1 },
    { name: "patrocinadores", maxCount: 20 }
  ]),
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
        const st = path.join(base, "status.txt");

        if (fs.existsSync(st) && fs.readFileSync(st, "utf8").trim() === "novo") {
          pedidos.push({ id, whatsapp, mes });
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

  if (!["novo", "em_producao", "pronto"].includes(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  fs.writeFileSync(path.join(base, "status.txt"), status, "utf8");

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
    const st = path.join(pdir, "status.txt");

    if (fs.existsSync(st) && fs.readFileSync(st, "utf8").trim() === "novo") {
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
    const statusPath = path.join(item.base, "status.txt");
    const resultadoFinalPath = path.join(item.base, "resultado_final.png");
    const status = fs.existsSync(statusPath)
      ? fs.readFileSync(statusPath, "utf8").trim()
      : (item.pedido.status || "novo");
    const imagemPronta = fs.existsSync(resultadoFinalPath);

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
      descricao_instagram: item.pedido.descricao_instagram || ""
    };
  });

  return res.json({ ok: true, pedidos });
});

app.get("/pedidos/:id/download-resultado", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const arquivo = path.join(base, "resultado_final.png");

  if (!fs.existsSync(arquivo)) {
    return res.status(404).json({ ok: false, error: "Resultado final não encontrado" });
  }

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
  const statusPath = path.join(base, "status.txt");
  const resultadoFinalPath = path.join(base, "resultado_final.png");

  let pedido = {};
  if (fs.existsSync(pedidoJsonPath)) {
    try {
      pedido = JSON.parse(fs.readFileSync(pedidoJsonPath, "utf8"));
    } catch {}
  }

  const status = fs.existsSync(statusPath)
    ? fs.readFileSync(statusPath, "utf8").trim()
    : "novo";

  const imagem_pronta = fs.existsSync(resultadoFinalPath);

  return res.json({
    ok: true,
    id: req.params.id,
    status,
    categoria: pedido.categoria || "",
    imagem_pronta,
    preview_url: imagem_pronta
      ? `${req.protocol}://${req.get("host")}/pedidos/${req.params.id}/preview`
      : null
  });
});

// ===== PREVIEW DA IMAGEM FINAL =====
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

  const previewPath = path.join(base, "resultado_final.png");

  if (!fs.existsSync(previewPath)) {
    return res.status(404).json({ ok: false, error: "Imagem ainda não ficou pronta" });
  }

  return res.sendFile(previewPath);
});

// ===== BAIXAR ZIP =====
app.get("/pedidos/:id/zip", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

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

// ===== ATUALIZAR STATUS =====
app.post("/pedidos/:id/status", auth, (req, res) => {
  const whatsapp = req.user.whatsapp;
  const base = getPedidoBase(whatsapp, req.params.id);

  if (!base) {
    return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
  }

  const { status } = req.body || {};

  if (!["novo", "em_producao", "pronto"].includes(status)) {
    return res.status(400).json({ ok: false, error: "status inválido" });
  }

  fs.writeFileSync(path.join(base, "status.txt"), status, "utf8");

  return res.json({ ok: true });
});

// ===== UPLOAD DO RESULTADO FINAL =====
app.post(
  "/bot/pedidos/:id/upload-resultado",
  auth,
  uploadResultado.single("resultado"),
  (req, res) => {

    const descricao_instagram = req.body?.descricao_instagram || "";
    if (!isBotAdmin(req)) {
      return res.status(403).json({ ok: false, error: "Acesso negado" });
    }

    const base = getPedidoBaseGlobal(req.params.id);

    if (!base) {
      return res.status(404).json({ ok: false, error: "Pedido não encontrado" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Arquivo resultado não enviado" });
    }

    const dest = path.join(base, "resultado_final.png");

    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(req.file.path, dest);

      fs.writeFileSync(path.join(base, "status.txt"), "pronto", "utf8");

      try {
        const pedidoPath = path.join(base, "pedido.json");
        if (fs.existsSync(pedidoPath)) {
          const pedidoData = JSON.parse(fs.readFileSync(pedidoPath, "utf8"));
          pedidoData.descricao_instagram = descricao_instagram || "";
          fs.writeFileSync(pedidoPath, JSON.stringify(pedidoData, null, 2), "utf8");
        }
      } catch (e) {}

      return res.json({
        ok: true,
        arquivo: "resultado_final.png"
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
      const statusPath = path.join(p.base, "status.txt");
      const resultadoFinalPath = path.join(p.base, "resultado_final.png");

      const status = fs.existsSync(statusPath)
        ? fs.readFileSync(statusPath, "utf8").trim()
        : (p.pedido.status || "novo");

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
    registrarOnline(req, { chat_aberto: true, ultima_acao: "suporte_poll" });

    const whatsapp = req.user.whatsapp;
    const abertas = readJsonArraySafe(SUPORTE_ABERTAS_FILE);
    const conversa = abertas.find(c => c.whatsapp === whatsapp && !c.finalizada);

    if (!conversa) {
      return res.json({ ok: true, conversa: null, mensagens: [] });
    }

    return res.json({
      ok: true,
      conversa_id: conversa.id,
      conversa,
      mensagens: conversa.mensagens || []
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
    const eventos = readJsonArraySafe(EVENTOS_CLIENTES_FILE).slice(-limite);

    return res.json({
      ok: true,
      total: eventos.length,
      eventos
    });
  } catch {
    return res.status(500).json({ ok:false, error:"erro_eventos_clientes" });
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



















