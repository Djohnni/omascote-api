function hasText(value) {
  return String(value === undefined || value === null ? "" : value).trim() !== "";
}

function getCleanFields(fields = {}) {
  return fields.new_model && fields.new_model.fields && typeof fields.new_model.fields === "object"
    ? fields.new_model.fields
    : {};
}

function scoreComplete(fields = {}) {
  const clean = getCleanFields(fields);
  const score = clean.score && typeof clean.score === "object" ? clean.score : null;

  if (score) {
    return hasText(score.home_team) &&
      hasText(score.home_score) &&
      hasText(score.away_score) &&
      hasText(score.away_team);
  }

  return hasText(fields.time_principal) &&
    hasText(fields.gols_time_principal) &&
    hasText(fields.gols_adversario) &&
    hasText(fields.time_adversario);
}

function matchupComplete(fields = {}) {
  const clean = getCleanFields(fields);
  const matchup = clean.matchup && typeof clean.matchup === "object" ? clean.matchup : null;

  if (matchup) {
    return hasText(matchup.home_team) && hasText(matchup.away_team);
  }

  return hasText(fields.time_principal) && hasText(fields.time_adversario);
}

function cleanText(fields = {}, key) {
  const clean = getCleanFields(fields);
  return clean[key];
}

function parsedArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function playersCount(fields = {}) {
  const cleanPlayers = cleanText(fields, "players");
  if (Array.isArray(cleanPlayers)) return cleanPlayers.length;

  return parsedArray(fields.jogadores_json).length;
}

function hasFile(files = {}, fieldName) {
  return Array.isArray(files[fieldName]) && files[fieldName].length > 0;
}

function missingFieldsFromRules(rules = [], fields = {}) {
  return rules
    .filter(rule => !rule.ok(fields))
    .map(rule => rule.name);
}

function missingFilesFromRules(rules = [], files = {}) {
  return rules
    .filter(rule => !hasFile(files, rule.field))
    .map(rule => rule.name || rule.field);
}

const PRODUCT_AUDIT_RULES = {
  resultado: {
    fields: [
      { name: "placar", ok: scoreComplete }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "escudo2", name: "escudo2" }
    ],
    motorWarnings: [
      "escudo2 e competicao divergem entre frontend novo e legado; observar antes de bloquear"
    ],
    futureErrors: [
      "resultado_sem_placar",
      "resultado_sem_escudo_principal",
      "resultado_sem_escudo_adversario"
    ]
  },

  escalacao: {
    fields: [
      { name: "confronto", ok: fields => hasText(fields.rodada) || hasText(cleanText(fields, "matchup")) },
      { name: "jogadores", ok: fields => playersCount(fields) > 0 || hasText(fields.jogadores_texto) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" }
    ],
    motorWarnings: [
      "frontend novo, legado e suporte divergem em data/hora, escudo e minimo de jogadores"
    ],
    futureErrors: [
      "escalacao_sem_confronto",
      "escalacao_sem_jogadores",
      "escalacao_sem_escudo"
    ]
  },

  contratacao: {
    fields: [
      { name: "titulo", ok: fields => hasText(fields.rodada) || hasText(cleanText(fields, "title")) },
      { name: "nome_jogador", ok: fields => hasText(fields.data) || hasText(cleanText(fields, "player_name")) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "escudo2", name: "foto_jogador" }
    ],
    futureErrors: [
      "contratacao_sem_titulo",
      "contratacao_sem_nome_jogador",
      "contratacao_sem_escudo",
      "contratacao_sem_foto_jogador"
    ]
  },

  proximo_jogo: {
    fields: [
      { name: "confronto", ok: matchupComplete },
      { name: "data_horario", ok: fields => hasText(fields.data) || hasText(cleanText(fields, "match_datetime")) },
      { name: "competicao", ok: fields => hasText(fields.hora) || hasText(cleanText(fields, "competition")) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "escudo2", name: "escudo2" }
    ],
    futureErrors: [
      "proximo_jogo_sem_confronto",
      "proximo_jogo_sem_data_horario",
      "proximo_jogo_sem_competicao",
      "proximo_jogo_sem_escudos"
    ]
  },

  patrocinador: {
    fields: [
      { name: "titulo", ok: fields => hasText(fields.rodada) || hasText(cleanText(fields, "title")) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "patrocinadores", name: "patrocinadores" }
    ],
    motorWarnings: [
      "confirmar se o motor aceita patrocinador sem logos antes de bloquear"
    ],
    futureErrors: [
      "patrocinador_sem_titulo",
      "patrocinador_sem_escudo",
      "patrocinador_sem_logos"
    ]
  },

  escudo3d: {
    files: [
      { field: "escudo1", name: "escudo1" }
    ],
    futureErrors: [
      "escudo3d_sem_escudo"
    ]
  },

  proximo_jogo_jogador: {
    fields: [
      { name: "confronto", ok: matchupComplete },
      { name: "data_horario", ok: fields => hasText(fields.data) || hasText(cleanText(fields, "match_datetime")) },
      { name: "competicao", ok: fields => hasText(fields.hora) || hasText(cleanText(fields, "competition")) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "escudo2", name: "escudo2" },
      { field: "mascote", name: "foto_jogador" }
    ],
    motorWarnings: [
      "produto jogador nao estava no escopo principal da fase; observar antes de bloquear"
    ],
    futureErrors: [
      "proximo_jogo_jogador_sem_confronto",
      "proximo_jogo_jogador_sem_foto"
    ]
  },

  resultado_jogo_jogador: {
    fields: [
      { name: "placar", ok: scoreComplete }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "escudo2", name: "escudo2" },
      { field: "mascote", name: "foto_jogador" }
    ],
    motorWarnings: [
      "produto jogador nao estava no escopo principal da fase; observar antes de bloquear"
    ],
    futureErrors: [
      "resultado_jogador_sem_placar",
      "resultado_jogador_sem_foto"
    ]
  },

  jogador_escudo: {
    fields: [
      { name: "nome_jogador", ok: fields => hasText(fields.data) || hasText(cleanText(fields, "player_name")) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "mascote", name: "foto_jogador" }
    ],
    futureErrors: [
      "jogador_escudo_sem_nome",
      "jogador_escudo_sem_escudo",
      "jogador_escudo_sem_foto"
    ]
  },

  mascote_uniforme: {
    fields: [
      { name: "animal_mascote", ok: fields => hasText(fields.data) || hasText(cleanText(fields, "mascot_animal")) }
    ],
    files: [
      { field: "escudo1", name: "escudo1" },
      { field: "mascote", name: "uniforme" }
    ],
    motorWarnings: [
      "uniforme e opcional no frontend novo, mas obrigatorio no legado; manter em monitoramento"
    ],
    futureErrors: [
      "mascote_uniforme_sem_animal",
      "mascote_uniforme_sem_escudo",
      "mascote_uniforme_sem_uniforme"
    ]
  }
};

function countWarnings(audit) {
  return audit.campos_ausentes.length +
    audit.arquivos_ausentes.length +
    audit.avisos_motor.length +
    audit.possiveis_erros_futuros.length;
}

function auditProductOrder({ categoria, fields = {}, files = {} }) {
  const produto = String(categoria || "").trim().toLowerCase();
  const rules = PRODUCT_AUDIT_RULES[produto] || null;

  const audit = {
    produto,
    campos_ausentes: [],
    arquivos_ausentes: [],
    avisos_motor: [],
    possiveis_erros_futuros: [],
    modo: "log",
    bloqueia_pedido: false
  };

  if (!rules) {
    audit.avisos_motor.push("produto sem regras de auditoria; nao bloquear sem revisar motor interno");
    audit.possiveis_erros_futuros.push("produto_sem_regra_auditoria");
    audit.total_avisos = countWarnings(audit);
    return audit;
  }

  audit.campos_ausentes = missingFieldsFromRules(rules.fields || [], fields);
  audit.arquivos_ausentes = missingFilesFromRules(rules.files || [], files);
  audit.avisos_motor = Array.isArray(rules.motorWarnings) ? rules.motorWarnings : [];
  audit.possiveis_erros_futuros = (rules.futureErrors || []).filter(error => {
    if (error.includes("_sem_escudo") || error.includes("_sem_foto") || error.includes("_sem_logos") || error.includes("_sem_uniforme")) {
      return audit.arquivos_ausentes.length > 0;
    }

    return audit.campos_ausentes.length > 0;
  });
  audit.total_avisos = countWarnings(audit);

  return audit;
}

function incrementCounter(counter, key, amount = 1) {
  const normalized = String(key || "").trim();
  if (!normalized) return;
  counter[normalized] = (counter[normalized] || 0) + amount;
}

function toSortedList(counter) {
  return Object.entries(counter)
    .map(([nome, total]) => ({ nome, total }))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome));
}

function summarizeAuditEntries(entries = []) {
  const avisosPorProduto = {};
  const eventosComAvisosPorProduto = {};
  const camposAusentes = {};
  const arquivosAusentes = {};

  entries.forEach(entry => {
    const produto = entry.produto || "desconhecido";
    const totalAvisos = Number(entry.total_avisos || 0);

    if (totalAvisos > 0) {
      incrementCounter(avisosPorProduto, produto, totalAvisos);
      incrementCounter(eventosComAvisosPorProduto, produto);
    }

    (entry.campos_ausentes || []).forEach(campo => incrementCounter(camposAusentes, campo));
    (entry.arquivos_ausentes || []).forEach(arquivo => incrementCounter(arquivosAusentes, arquivo));
  });

  return {
    total_eventos: entries.length,
    total_eventos_com_avisos: Object.values(eventosComAvisosPorProduto).reduce((sum, value) => sum + value, 0),
    avisos_por_produto: avisosPorProduto,
    eventos_com_avisos_por_produto: eventosComAvisosPorProduto,
    campos_mais_ausentes: toSortedList(camposAusentes),
    arquivos_mais_ausentes: toSortedList(arquivosAusentes)
  };
}

module.exports = {
  auditProductOrder,
  summarizeAuditEntries
};
