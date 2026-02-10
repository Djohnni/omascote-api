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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const PEDIDOS_DIR = path.join(DATA_DIR, "pedidos");
const TIMES_DIR = path.join(DATA_DIR, "times");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const TMP_UPLOADS = path.join(DATA_DIR, "tmp_uploads");

// CORS
app.use(cors({ origin: ["https://omascote.com.br"], credentials: false }));
app.use(express.json({ limit: "2mb" }));

// ===== GARANTE PASTAS =====
function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(DATA_DIR);
ensureDir(PEDIDOS_DIR);
ensureDir(TIMES_DIR);
ensureDir(TMP_UPLOADS);
if (!fs.existsSync(CLIENTES_FILE)) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify({}, null, 2), "utf8");
}

// ===== HELPERS =====
function readClientes(){
  return JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8") || "{}");
}
function writeClientes(obj){
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(obj, null, 2), "utf8");
}
function nowYYYYMM(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function newPedidoId(){
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}_` +
         `${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;
}
function auth(req,res,next){
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok:false, error:"Sem token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok:false, error:"Token inválido" });
  }
}

// ===== UPLOAD =====
const storage = multer.diskStorage({
  destination: (req,file,cb)=>cb(null, TMP_UPLOADS),
  filename: (req,file,cb)=>{
    const safe = file.originalname.replace(/[^\w.\-]+/g,"_");
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

// ===== ROTAS =====

// Health
app.get("/", (req,res)=>res.json({ ok:true, msg:"omascote-api online" }));

// Login
app.post("/auth/login",(req,res)=>{
  const { whatsapp, senha } = req.body || {};
  if (!whatsapp || !senha) return res.status(400).json({ ok:false });

  const clientes = readClientes();
  const c = clientes[whatsapp];
  if (!c) return res.status(401).json({ ok:false, error:"Cliente não encontrado" });
  if (!c.ativo) return res.status(403).json({ ok:false, error:"Mensalidade inativa" });

  if (!bcrypt.compareSync(senha, c.senha_hash)) {
    return res.status(401).json({ ok:false, error:"Senha incorreta" });
  }

  const mesAtual = nowYYYYMM();
  if (c.ciclo_mes !== mesAtual){
    c.ciclo_mes = mesAtual;
    c.usados_no_ciclo = 0;
    clientes[whatsapp] = c;
    writeClientes(clientes);
  }

  const token = jwt.sign({ whatsapp }, JWT_SECRET, { expiresIn:"7d" });
  res.json({
    ok:true,
    token,
    nome_time:c.nome_time,
    plano:c.plano,
    usados_no_ciclo:c.usados_no_ciclo
  });
});

// Perfil
app.get("/me", auth, (req,res)=>{
  const clientes = readClientes();
  const c = clientes[req.user.whatsapp];
  if (!c) return res.status(404).json({ ok:false, error:"Cliente não encontrado" });
  res.json({ ok:true, nome_time:c.nome_time, plano:c.plano, usados_no_ciclo:c.usados_no_ciclo, ativo:c.ativo });
});

// Criar pedido
app.post(
  "/pedidos",
  auth,
  upload.fields([
    { name:"escudo1", maxCount:1 }, // escudo do time
    { name:"escudo2", maxCount:1 }, // escudo do adversário
    { name:"mascote", maxCount:1 }, // mascote do time (opcional)
    { name:"patrocinadores", maxCount:20 }
  ]),
  (req,res)=>{
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];
    if (!c || !c.ativo) return res.status(403).json({ ok:false, error:"Mensalidade inativa" });

    // Reseta ciclo se mudou o mês
    const mesAtual = nowYYYYMM();
    if (c.ciclo_mes !== mesAtual){
      c.ciclo_mes = mesAtual;
      c.usados_no_ciclo = 0;
    }

    if (c.usados_no_ciclo >= c.plano){
      clientes[whatsapp] = c;
      writeClientes(clientes);
      return res.status(403).json({ ok:false, error:`Limite mensal atingido (${c.plano})` });
    }

    const { rodada, data, hora, arena, mascote_tipo } = req.body || {};
    if (!rodada || !data || !hora || !arena){
      return res.status(400).json({ ok:false, error:"rodada, data, hora e arena são obrigatórios" });
    }

    const files = req.files || {};

    // ===== TIME (persistente) =====
    const timeDir = path.join(TIMES_DIR, whatsapp);
    ensureDir(timeDir);

    // Salva no time (persistente)
    if (files["escudo1"]?.[0]) {
      fs.copyFileSync(files["escudo1"][0].path, path.join(timeDir, "escudo.png"));
    }
    if (files["mascote"]?.[0]) {
      fs.copyFileSync(files["mascote"][0].path, path.join(timeDir, "mascote.png"));
    }

    // ===== PEDIDO (COMPLETO COMO ANTES — AHK COMPATÍVEL) =====
    const id = newPedidoId();
    const base = path.join(PEDIDOS_DIR, whatsapp, mesAtual, id);
    ensureDir(base);
    ensureDir(path.join(base, "patrocinadores"));

    // IMPORTANTÍSSIMO: nomes iguais ao fluxo antigo
    if (files["escudo1"]?.[0]) {
      fs.copyFileSync(files["escudo1"][0].path, path.join(base, "escudo1.png"));
    }
    if (files["escudo2"]?.[0]) {
      fs.renameSync(files["escudo2"][0].path, path.join(base, "escudo2.png"));
    }
    if (files["mascote"]?.[0]) {
      fs.copyFileSync(files["mascote"][0].path, path.join(base, "mascote.png"));
    }

    // Patrocinadores
    const pats = files["patrocinadores"] || [];
    pats.forEach((f,i)=>{
      fs.renameSync(f.path, path.join(base, "patrocinadores", `pat${String(i+1).padStart(2,"0")}.png`));
    });

    const pedido = {
      id,
      whatsapp,
      mes: mesAtual,
      rodada,
      data,
      hora,
      arena,
      mascote_tipo: mascote_tipo || "",
      patrocinadores_qtd: pats.length,
      status: "novo",
      criado_em: new Date().toISOString()
    };

    fs.writeFileSync(path.join(base, "pedido.json"), JSON.stringify(pedido, null, 2), "utf8");
    fs.writeFileSync(path.join(base, "status.txt"), "novo", "utf8");

    c.usados_no_ciclo = (c.usados_no_ciclo || 0) + 1;
    c.ciclo_mes = mesAtual;
    clientes[whatsapp] = c;
    writeClientes(clientes);

    res.json({ ok:true, pedido_id:id });
  }
);

// Listar pedidos "novo"
app.get("/pedidos/novos", auth, (req,res)=>{
  const whatsapp = req.user.whatsapp;
  const mesAtual = nowYYYYMM();
  const dir = path.join(PEDIDOS_DIR, whatsapp, mesAtual);

  if (!fs.existsSync(dir)) return res.json({ ok:true, pedidos:[] });

  const pedidos = [];
  for (const id of fs.readdirSync(dir)) {
    const pdir = path.join(dir, id);
    const st = path.join(pdir, "status.txt");
    if (fs.existsSync(st) && fs.readFileSync(st, "utf8").trim() === "novo") {
      pedidos.push({ id });
    }
  }
  res.json({ ok:true, pedidos });
});

// Baixar zip do pedido
app.get("/pedidos/:id/zip", auth, (req,res)=>{
  const whatsapp = req.user.whatsapp;
  const mesAtual = nowYYYYMM();
  const base = path.join(PEDIDOS_DIR, whatsapp, mesAtual, req.params.id);
  if (!fs.existsSync(base)) return res.status(404).json({ ok:false, error:"Pedido não encontrado" });

  res.setHeader("Content-Type","application/zip");
  res.setHeader("Content-Disposition",`attachment; filename="${req.params.id}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", err => res.status(500).end(String(err)));
  archive.pipe(res);

  archive.directory(base, false);
  archive.finalize();
});

// Atualizar status
app.post("/pedidos/:id/status", auth, (req,res)=>{
  const whatsapp = req.user.whatsapp;
  const mesAtual = nowYYYYMM();
  const base = path.join(PEDIDOS_DIR, whatsapp, mesAtual, req.params.id);
  if (!fs.existsSync(base)) return res.status(404).json({ ok:false, error:"Pedido não encontrado" });

  const { status } = req.body || {};
  if (!["novo", "em_producao", "pronto"].includes(status)) {
    return res.status(400).json({ ok:false, error:"status inválido" });
  }

  fs.writeFileSync(path.join(base, "status.txt"), status, "utf8");
  res.json({ ok:true });
});

app.listen(PORT, ()=>console.log("API rodando na porta", PORT));
