const path = require("path");
const fs = require("fs");
const orderStorage = require("./order.storage");
const orderStatus = require("./order.status");

function buildOrderBasePath({ pedidosDir, whatsapp, mesAtual, id }) {
  return path.join(pedidosDir, whatsapp, mesAtual, id);
}

function ensureOrderDirectory(base) {
  orderStorage.ensureDir(base);
}

function safeParseJsonObject(value, fallback = {}) {
  if (!value) return fallback;

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") return fallback;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function validateJsonField(value, fieldName, errors) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "object") return;
  if (typeof value !== "string") return;

  try {
    JSON.parse(value);
  } catch {
    errors.push(`${fieldName} contem JSON invalido`);
  }
}

function validateOrderJsonBody(body = {}, categoria = "") {
  const errors = [];
  const categoriaNormalizada = String(categoria || "").trim().toLowerCase();

  validateJsonField(body.fields_json || body.fields, "fields_json", errors);
  validateJsonField(body.assets_json || body.assets, "assets_json", errors);

  if (categoriaNormalizada === "resultado") {
    validateJsonField(body.artilheiros, "artilheiros", errors);
  }

  if (["escalacao", "jogador_escudo", "mascote_uniforme"].includes(categoriaNormalizada)) {
    validateJsonField(body.jogadores_json, "jogadores_json", errors);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function normalizeNewOrderModel(body = {}) {
  const schemaVersion = Number(body.schema_version || body.schemaVersion || 0);

  return {
    schema_version: Number.isFinite(schemaVersion) && schemaVersion > 0 ? schemaVersion : undefined,
    product_id: body.product_id ? String(body.product_id) : "",
    fields: safeParseJsonObject(body.fields_json || body.fields, {}),
    assets: safeParseJsonObject(body.assets_json || body.assets, {})
  };
}

function normalizeOrderBody(body = {}) {
  const newModel = normalizeNewOrderModel(body);

  return {
    rodada: body.rodada,
    data: body.data,
    hora: body.hora,
    arena: body.arena,
    mascote_tipo: body.mascote_tipo,
    flyer_tipo: body.flyer_tipo,
    artilheiros: body.artilheiros,
    jogadores_json: body.jogadores_json,
    jogadores_texto: body.jogadores_texto,
    time_principal: body.time_principal,
    gols_time_principal: body.gols_time_principal,
    gols_adversario: body.gols_adversario,
    time_adversario: body.time_adversario,
    origem_acesso: body.origem_acesso,
    display_mode: body.display_mode,
    titulo_secao_resultados: body.titulo_secao_resultados,
    titulo_secao_proximo_jogo: body.titulo_secao_proximo_jogo,
    new_model: newModel
  };
}

function hasRequiredOrderFields(fields) {
  return !!(fields.rodada && fields.data);
}

function getUploadPermissions(categoria) {
  return {
    podeUsarEscudo1: ["resultado", "escalacao", "contratacao", "proximo_jogo", "patrocinador", "escudo3d", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo", "mascote_uniforme"].includes(categoria),
    podeUsarEscudo2: ["resultado", "escalacao", "contratacao", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria),
    escudo2EhFotoJogador: false,
    podeUsarMascote: ["resultado", "escalacao", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo", "mascote_uniforme"].includes(categoria),
    podeUsarPatrocinadores: categoria === "patrocinador"
  };
}

function getMaxFotosMascote(categoria) {
  if (["proximo_jogo", "resultado"].includes(categoria)) return 4;
  if (["proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria)) return 3;
  return 1;
}

function textoTituloSecaoArte(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function tituloSecaoPedido({ categoria, fields, newModel }) {
  if (categoria === "resultado") {
    return {
      key: "titulo_secao_resultados",
      value: textoTituloSecaoArte(
        fields.titulo_secao_resultados ?? newModel?.fields?.titulo_secao_resultados,
        "Últimos Resultados"
      )
    };
  }

  if (categoria === "proximo_jogo") {
    return {
      key: "titulo_secao_proximo_jogo",
      value: textoTituloSecaoArte(
        fields.titulo_secao_proximo_jogo ?? newModel?.fields?.titulo_secao_proximo_jogo,
        "Próximo Jogo"
      )
    };
  }

  return null;
}

function moveUploadedFileObject({ file, base, field, destName }) {
  const f = file;
  if (!f) return null;

  const dest = path.join(base, destName);

  if (!f.path || !fs.existsSync(f.path)) {
    console.error("[order.upload] arquivo temporario nao encontrado", {
      field,
      origem: f.path || "",
      destino: dest
    });

    const err = new Error(`Arquivo de upload não encontrado: ${field}`);
    err.code = "UPLOAD_TEMP_FILE_MISSING";
    throw err;
  }

  try {
    fs.renameSync(f.path, dest);
  } catch (e) {
    console.error("[order.upload] falha ao mover upload", {
      field,
      origem: f.path || "",
      destino: dest,
      erro: e.message
    });

    const err = new Error(`Falha ao salvar arquivo de upload: ${field}`);
    err.code = "UPLOAD_MOVE_FAILED";
    throw err;
  }

  return dest;
}

function moveUploadedFile({ files, base, field, destName }) {
  return moveUploadedFileObject({ file: files[field]?.[0], base, field, destName });
}

function moveOrderUploads({ categoria, files, base }) {
  const permissions = getUploadPermissions(categoria);
  const fotosExtras = [];

  if (permissions.podeUsarEscudo1) {
    moveUploadedFile({ files, base, field: "escudo1", destName: "escudo1.png" });
  }

  if (permissions.podeUsarEscudo2) {
    moveUploadedFile({ files, base, field: "escudo2", destName: "escudo2.png" });
  }

  if (permissions.escudo2EhFotoJogador) {
    moveUploadedFile({ files, base, field: "escudo2", destName: "mascote.png" });
  }

  if (permissions.podeUsarMascote) {
    moveUploadedFile({ files, base, field: "mascote", destName: "mascote.png" });

    const maxFotosMascote = getMaxFotosMascote(categoria);
    const mascoteFiles = files["mascote"] || [];

    for (let i = 1; i < Math.min(mascoteFiles.length, maxFotosMascote); i++) {
      const destName = `foto${i + 1}.png`;
      moveUploadedFileObject({ file: mascoteFiles[i], base, field: "mascote", destName });
      fotosExtras.push(destName);
    }
  }

  const pats = permissions.podeUsarPatrocinadores ? (files["patrocinadores"] || []) : [];

  pats.forEach((f, i) => {
    const dest = path.join(base, `pat${String(i + 1).padStart(2, "0")}.png`);
    fs.renameSync(f.path, dest);
  });

  return {
    ...permissions,
    pats,
    fotosExtras
  };
}

function buildPedidoData({
  categoria,
  id,
  whatsapp,
  mesAtual,
  fields,
  files,
  pats,
  podeUsarEscudo1,
  podeUsarEscudo2,
  escudo2EhFotoJogador,
  podeUsarMascote,
  fotosExtras = []
}) {
  const {
    rodada,
    data,
    hora,
    arena,
    mascote_tipo,
    artilheiros,
    jogadores_json,
    jogadores_texto,
    time_principal,
    gols_time_principal,
    gols_adversario,
    time_adversario,
    origem_acesso,
    display_mode,
    titulo_secao_resultados,
    titulo_secao_proximo_jogo,
    new_model
  } = fields;
  const tituloSecao = tituloSecaoPedido({
    categoria,
    fields: {
      titulo_secao_resultados,
      titulo_secao_proximo_jogo
    },
    newModel: new_model || {}
  });

  const pedido = {
    time_principal: ["resultado", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria) ? (time_principal || "") : "",
    gols_time_principal: ["resultado", "resultado_jogo_jogador"].includes(categoria) ? (Number(gols_time_principal) || 0) : 0,
    gols_adversario: ["resultado", "resultado_jogo_jogador"].includes(categoria) ? (Number(gols_adversario) || 0) : 0,
    time_adversario: ["resultado", "proximo_jogo", "proximo_jogo_jogador", "resultado_jogo_jogador"].includes(categoria) ? (time_adversario || "") : "",

    artilheiros: categoria === "resultado" && artilheiros ? JSON.parse(artilheiros) : [],
    jogadores: ["escalacao", "jogador_escudo", "mascote_uniforme"].includes(categoria) && jogadores_json ? JSON.parse(jogadores_json) : [],
    jogadores_texto: ["escalacao", "jogador_escudo", "mascote_uniforme"].includes(categoria) ? (jogadores_texto || "") : "",

    escudo_principal: podeUsarEscudo1 && files["escudo1"]?.[0] ? "escudo1.png" : "",
    escudo_adversario: podeUsarEscudo2 && files["escudo2"]?.[0] ? "escudo2.png" : "",
    foto_jogo: ((podeUsarMascote && files["mascote"]?.[0]) || (escudo2EhFotoJogador && files["escudo2"]?.[0])) ? "mascote.png" : "",
    fotos_extras: Array.isArray(fotosExtras) ? fotosExtras : [],

    categoria: categoria,
    id,
    whatsapp,
    mes: mesAtual,
    rodada,
    data,
    hora: ["resultado", "resultado_jogo_jogador", "contratacao", "proximo_jogo", "proximo_jogo_jogador", "escalacao"].includes(categoria) ? (hora || "") : "",
    arena: ["proximo_jogo", "proximo_jogo_jogador", "escalacao"].includes(categoria) ? (arena || "") : "",
    mascote_tipo: mascote_tipo || "",
    patrocinadores_qtd: pats.length,
    status: "novo",
    aprovado_cliente: false,
    baixado_cliente: false,
    ajuste_automatico_usado: false,
    motivo_ajuste: "",
    origem_acesso: origem_acesso === "pwa" ? "pwa" : "navegador",
    display_mode: display_mode === "standalone" ? "standalone" : "browser",
    criado_em: new Date().toISOString()
  };

  if (tituloSecao) {
    pedido[tituloSecao.key] = tituloSecao.value;
    pedido.titulo_secao_arte = tituloSecao.value;
  }

  const cleanModel = new_model || {};

  if (cleanModel.schema_version || cleanModel.product_id || Object.keys(cleanModel.fields || {}).length || Object.keys(cleanModel.assets || {}).length) {
    pedido.schema_version = cleanModel.schema_version || 1;
    pedido.product_id = cleanModel.product_id || categoria;
    pedido.fields = cleanModel.fields || {};
    if (tituloSecao) {
      pedido.fields[tituloSecao.key] = tituloSecao.value;
      pedido.fields.titulo_secao_arte = tituloSecao.value;
    }
    pedido.assets = cleanModel.assets || {};
    pedido.legacy = {
      time_principal: pedido.time_principal,
      gols_time_principal: pedido.gols_time_principal,
      gols_adversario: pedido.gols_adversario,
      time_adversario: pedido.time_adversario,
      artilheiros: pedido.artilheiros,
      jogadores: pedido.jogadores,
      jogadores_texto: pedido.jogadores_texto,
      escudo_principal: pedido.escudo_principal,
      escudo_adversario: pedido.escudo_adversario,
      foto_jogo: pedido.foto_jogo,
      fotos_extras: pedido.fotos_extras,
      categoria: pedido.categoria,
      rodada: pedido.rodada,
      data: pedido.data,
      hora: pedido.hora,
      arena: pedido.arena,
      mascote_tipo: pedido.mascote_tipo,
      patrocinadores_qtd: pedido.patrocinadores_qtd,
      ...(tituloSecao ? {
        [tituloSecao.key]: tituloSecao.value,
        titulo_secao_arte: tituloSecao.value
      } : {})
    };
  }

  return pedido;
}

function persistNewOrder({ base, pedido }) {
  orderStorage.writeOrder(base, pedido);
  orderStorage.writeStatus(base, orderStatus.ORDER_STATUS.NOVO);
}

function createOrderDraft({ categoria, pedidosDir, whatsapp, mesAtual, fields, files }) {
  const id = orderStorage.newPedidoId();
  const base = buildOrderBasePath({ pedidosDir, whatsapp, mesAtual, id });

  ensureOrderDirectory(base);

  const uploadResult = moveOrderUploads({ categoria, files, base });

  const pedido = buildPedidoData({
    categoria,
    id,
    whatsapp,
    mesAtual,
    fields,
    files,
    pats: uploadResult.pats,
    podeUsarEscudo1: uploadResult.podeUsarEscudo1,
    podeUsarEscudo2: uploadResult.podeUsarEscudo2,
    escudo2EhFotoJogador: uploadResult.escudo2EhFotoJogador,
    podeUsarMascote: uploadResult.podeUsarMascote,
    fotosExtras: uploadResult.fotosExtras
  });

  persistNewOrder({ base, pedido });

  return {
    id,
    base,
    fields,
    pedido,
    uploadResult
  };
}

module.exports = {
  orderStorage,
  orderStatus,
  buildOrderBasePath,
  ensureOrderDirectory,
  safeParseJsonObject,
  validateOrderJsonBody,
  normalizeNewOrderModel,
  normalizeOrderBody,
  hasRequiredOrderFields,
  getUploadPermissions,
  moveUploadedFile,
  moveOrderUploads,
  buildPedidoData,
  persistNewOrder,
  createOrderDraft
};
