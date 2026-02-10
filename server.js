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
  if (!c || !c.ativo) return res.status(403).json({ ok:false });

  if (!bcrypt.compareSync(senha, c.senha_hash)) {
    return res.status(401).json({ ok:false });
  }

  const mesAtual = nowYYYYMM();
  if (c.ciclo_mes !== mesAtual){
    c.ciclo_mes = mesAtual;
    c.usados_no_ciclo = 0;
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
  const c = readClientes()[req.user.whatsapp];
  if (!c) return res.status(404).json({ ok:false });
  res.json({ ok:true, nome_time:c.nome_time, plano:c.plano, usados_no_ciclo:c.usados_no_ciclo, ativo:c.ativo });
});

// Criar pedido
app.post(
  "/pedidos",
  auth,
  upload.fields([
    { name:"escudo1", maxCount:1 },
    { name:"mascote", maxCount:1 },
    { name:"patrocinadores", maxCount:20 }
  ]),
  (req,res)=>{
    const whatsapp = req.user.whatsapp;
    const clientes = readClientes();
    const c = clientes[whatsapp];
    if (!c || !c.ativo) return res.status(403).json({ ok:false });

    const mesAtual = nowYYYYMM();
    if (c.ciclo_mes !== mesAtual){
      c.ciclo_mes = mesAtual;
      c.usados_no_ciclo = 0;
    }
    if (c.usados_no_ciclo >= c.plano){
      writeClientes(clientes);
      return res.status(403).json({ ok:false });
    }

    const { rodada, data, hora, arena, mascote_tipo } = req.body || {};
    if (!rodada || !data || !hora || !arena){
      return res.status(400).json({ ok:false });
    }

    // ===== SALVA ESCUDO / MASCOTE DO TIME =====
    const timeDir = path.join(TIMES_DIR, whatsapp);
    ensureDir(timeDir);

    const files = req.files || {};

    if (files["escudo1"]?.[0]) {
      fs.renameSync(files["escudo1"][0].path, path.join(timeDir, "escudo.png"));
    }
    if (files["mascote"]?.[0]) {
      fs.renameSync(files["mascote"][0].path, path.join(timeDir, "mascote.png"));
    }

    // ===== PEDIDO =====
    const id = newPedidoId();
    const base = path.join(PEDIDOS_DIR, whatsapp, mesAtual, id);
    ensureDir(base);
    ensureDir(path.join(base,"patrocinadores"));

    const pats = files["patrocinadores"] || [];
    pats.forEach((f,i)=>{
      fs.renameSync(f.path, path.join(base,"patrocinadores",`pat${i+1}.png`));
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
      usa_escudo_time: true,
      usa_mascote_time: fs.existsSync(path.join(timeDir,"mascote.png")),
      patrocinadores_qtd: pats.length,
      status: "novo",
      criado_em: new Date().toISOString()
    };

    fs.writeFileSync(path.join(base,"pedido.json"), JSON.stringify(pedido,null,2));
    fs.writeFileSync(path.join(base,"status.txt"), "novo");

    c.usados_no_ciclo++;
    clientes[whatsapp] = c;
    writeClientes(clientes);

    res.json({ ok:true, pedido_id:id });
  }
);

// Listar novos
app.get("/pedidos/novos", auth, (req,res)=>{
  const dir = path.join(PEDIDOS_DIR, req.user.whatsapp, nowYYYYMM());
  if (!fs.existsSync(dir)) return res.json({ ok:true, pedidos:[] });

  const pedidos = fs.readdirSync(dir).filter(id=>{
    const st = path.join(dir,id,"status.txt");
    return fs.existsSync(st) && fs.readFileSync(st,"utf8").trim()==="novo";
  }).map(id=>({ id }));

  res.json({ ok:true, pedidos });
});

// Zip
app.get("/pedidos/:id/zip", auth, (req,res)=>{
  const base = path.join(PEDIDOS_DIR, req.user.whatsapp, nowYYYYMM(), req.params.id);
  if (!fs.existsSync(base)) return res.status(404).json({ ok:false });

  res.setHeader("Content-Type","application/zip");
  res.setHeader("Content-Disposition",`attachment; filename="${req.params.id}.zip"`);

  const archive = archiver("zip",{ zlib:{ level:9 }});
  archive.pipe(res);
  archive.directory(base,false);
  archive.finalize();
});

// Status
app.post("/pedidos/:id/status", auth, (req,res)=>{
  const base = path.join(PEDIDOS_DIR, req.user.whatsapp, nowYYYYMM(), req.params.id);
  if (!fs.existsSync(base)) return res.status(404).json({ ok:false });

  fs.writeFileSync(path.join(base,"status.txt"), req.body.status);
  res.json({ ok:true });
});

app.listen(PORT, ()=>console.log("API rodando na porta", PORT));
