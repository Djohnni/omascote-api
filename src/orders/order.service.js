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
    podeUsarMascote: ["resultado", "escalacao", "proximo_jogo_jogador", "resultado_jogo_jogador", "jogador_escudo", "mascote_uniforme"].includes(categoria),
    podeUsarPatrocinadores: categoria === "patrocinador"
  };
}

function moveUploadedFile({ files, base, field, destName }) {
  const f = files[field]?.[0];
  if (!f) return null;

  const dest = path.join(base, destName);
  fs.renameSync(f.path, dest);

  return dest;
}

function moveOrderUploads({ categoria, files, base }) {
  const permissions = getUploadPermissions(categoria);

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
  }

  const pats = permissions.podeUsarPatrocinadores ? (files["patrocinadores"] || []) : [];

  pats.forEach((f, i) => {
    const dest = path.join(base, `pat${String(i + 1).padStart(2, "0")}.png`);
    fs.renameSync(f.path, dest);
  });

  return {
    ...permissions,
    pats
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
  podeUsarMascote
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
    new_model
  } = fields;

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
    criado_em: new Date().toISOString()
  };

  const cleanModel = new_model || {};

  if (cleanModel.schema_version || cleanModel.product_id || Object.keys(cleanModel.fields || {}).length || Object.keys(cleanModel.assets || {}).length) {
    pedido.schema_version = cleanModel.schema_version || 1;
    pedido.product_id = cleanModel.product_id || categoria;
    pedido.fields = cleanModel.fields || {};
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
      categoria: pedido.categoria,
      rodada: pedido.rodada,
      data: pedido.data,
      hora: pedido.hora,
      arena: pedido.arena,
      mascote_tipo: pedido.mascote_tipo,
      patrocinadores_qtd: pedido.patrocinadores_qtd
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
    podeUsarMascote: uploadResult.podeUsarMascote
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
