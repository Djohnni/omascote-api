const assert = require("node:assert/strict");
const { __fotoJogosTest } = require("./server");

function jogo(overrides = {}) {
  return {
    time_a: "Time A",
    time_b: "Time B",
    resultado_gols_a: "",
    resultado_gols_b: "",
    data: "",
    horario: "",
    competicao: "",
    rodada: "",
    fase: "",
    local: "",
    numero_jogo: "",
    categoria: "",
    grupo: "",
    observacao: "",
    status: "",
    placar_tempo_normal: "",
    placar_final: "",
    disputa_penaltis: "",
    cidade: "",
    estadio_ginasio: "",
    modalidade: "",
    genero: "",
    classificacao: "",
    patrocinadores: "",
    organizador: "",
    transmissao: "",
    events: [],
    additional_information: [],
    ...overrides
  };
}

const saoPaulo = jogo({
  time_a: "São Paulo",
  time_b: "Athletico-PR",
  resultado_gols_a: "1",
  resultado_gols_b: "2",
  competicao: "Brasileirão Série A",
  status: "Encerrado",
  placar_tempo_normal: "1 x 2",
  placar_final: "1 x 2",
  modalidade: "futebol",
  additional_information: ["Imagem mostra o resultado final.", "Texto visível na imagem."],
  events: [
    { type: "goal", team: "São Paulo", player: "Artur Victor Guimarães", minute: "19'", details: "" },
    { type: "goal", team: "Athletico-PR", player: "Leozinho", minute: "46'", details: "" },
    { type: "goal", team: "Athletico-PR", player: "Leozinho", minute: "51'", details: "" }
  ]
});

const casos = [
  {
    nome: "São Paulo x Athletico-PR no formato exato",
    entrada: saoPaulo,
    exato: [
      "Competição:",
      "Brasileirão Série A",
      "",
      "Resultado:",
      "São Paulo 1 x 2 Athletico-PR",
      "",
      "Situação:",
      "Encerrado",
      "",
      "Autores dos gols:",
      "",
      "São Paulo",
      "• Artur Victor Guimarães — 19'",
      "",
      "Athletico-PR",
      "• Leozinho — 46'",
      "• Leozinho — 51'"
    ].join("\n"),
    ausentes: ["Mais informações", "Placar final", "Modalidade", "Imagem mostra", "Texto visível"]
  },
  {
    nome: "resultado sem autores",
    entrada: jogo({ resultado_gols_a: "3", resultado_gols_b: "1", status: "Encerrado" }),
    esperados: ["Resultado:\nTime A 3 x 1 Time B", "Situação:\nEncerrado"],
    ausentes: ["Autores dos gols", "Cartões", "Expulsões"]
  },
  {
    nome: "gols dos dois times e jogador com dois gols",
    entrada: jogo({
      resultado_gols_a: "2",
      resultado_gols_b: "1",
      events: [
        { type: "goal", team: "Time A", player: "Carlos", minute: "12'", details: "" },
        { type: "goal", team: "Time B", player: "Pedro", minute: "38'", details: "" },
        { type: "goal", team: "Time A", player: "Carlos", minute: "57'", details: "" }
      ]
    }),
    esperados: ["Time A\n• Carlos — 12'\n• Carlos — 57'", "Time B\n• Pedro — 38'"]
  },
  {
    nome: "gol de pênalti e gol contra",
    entrada: jogo({
      events: [
        { type: "goal", team: "Time A", player: "Ana", minute: "10'", details: "pênalti" },
        { type: "goal", team: "Time B", player: "Bia", minute: "44'", details: "gol contra" }
      ]
    }),
    esperados: ["• Ana — 10' (pênalti)", "• Bia — 44' (gol contra)"]
  },
  {
    nome: "disputa por pênaltis sem placar redundante",
    entrada: jogo({
      resultado_gols_a: "1",
      resultado_gols_b: "1",
      placar_final: "1 x 1",
      disputa_penaltis: "Time A 5 x 4 Time B"
    }),
    esperados: ["Disputa por pênaltis:\nTime A 5 x 4 Time B"],
    ausentes: ["Placar final"]
  },
  {
    nome: "cartões e expulsões separados",
    entrada: jogo({
      events: [
        { type: "yellow_card", team: "Time A", player: "João", minute: "33'", details: "" },
        { type: "red_card", team: "Time B", player: "Marcos", minute: "71'", details: "" }
      ]
    }),
    esperados: ["Cartões:\n\nTime A\n• João — 33'", "Expulsões:\n\nTime B\n• Marcos — 71'"],
    ausentes: ["Outros eventos"]
  },
  {
    nome: "informação incerta isolada",
    entrada: jogo({
      additional_information: [
        "Possível horário: 19h30 - confirmar.",
        "Possível indicação de tempo/placar extra: ícone '90' - confirmar.",
        "Imagem mostra dois escudos.",
        "Foi identificado futebol."
      ]
    }),
    esperados: ["Confirmar:\n• Possível horário: 19h30 - confirmar."],
    ausentes: ["Imagem mostra", "Foi identificado", "ícone", "placar extra"]
  },
  {
    nome: "próximo do limite",
    entrada: jogo({
      resultado_gols_a: "4",
      resultado_gols_b: "3",
      competicao: "Campeonato Regional",
      status: "Encerrado",
      local: "Estádio Municipal",
      classificacao: "Classificação " + "muito detalhada ".repeat(20),
      patrocinadores: "Patrocinadores " + "Clube Parceiro ".repeat(20),
      organizador: "Liga Organizadora " + "Regional ".repeat(20),
      transmissao: "Canal oficial " + "ao vivo ".repeat(20),
      events: [
        { type: "goal", team: "Time A", player: "Artilheiro", minute: "90+4'", details: "" }
      ]
    }),
    esperados: ["Resultado:\nTime A 4 x 3 Time B", "• Artilheiro — 90+4'"]
  }
];

for (const caso of casos) {
  const [saida] = __fotoJogosTest.normalizarRespostaJogosFoto({ jogos: [caso.entrada] });
  assert.ok(saida, `${caso.nome}: jogo descartado`);
  assert.ok(saida.observacao.length <= 1200, `${caso.nome}: excedeu 1.200 caracteres`);
  if (caso.exato !== undefined) {
    assert.equal(saida.observacao, caso.exato, `${caso.nome}: formato divergente`);
  }
  for (const esperado of caso.esperados || []) {
    assert.ok(saida.observacao.includes(esperado), `${caso.nome}: ausente "${esperado}"`);
  }
  for (const ausente of caso.ausentes || []) {
    assert.ok(!saida.observacao.includes(ausente), `${caso.nome}: dado indevido "${ausente}"`);
  }
  console.log(`OK - ${caso.nome}`);
}

const multiplos = __fotoJogosTest.normalizarRespostaJogosFoto({
  jogos: [
    saoPaulo,
    jogo({
      time_a: "União",
      time_b: "Nacional",
      resultado_gols_a: "3",
      resultado_gols_b: "0",
      competicao: "Campeonato Municipal",
      status: "Encerrado",
      events: [
        { type: "goal", team: "União", player: "Carlos", minute: "12'", details: "" },
        { type: "goal", team: "União", player: "Pedro", minute: "38'", details: "" },
        { type: "goal", team: "União", player: "Carlos", minute: "57'", details: "" }
      ]
    }),
    jogo({
      time_a: "Azul",
      time_b: "Verde",
      horario: "20:30",
      competicao: "Copa Estadual",
      status: "Agendado"
    })
  ]
});
assert.equal(multiplos.length, 3, "vários jogos: quantidade ou ordem alterada");
assert.ok(multiplos[0].observacao.includes("Artur Victor Guimarães"));
assert.ok(!multiplos[0].observacao.includes("Carlos"));
assert.ok(multiplos[1].observacao.includes("Carlos"));
assert.ok(!multiplos[1].observacao.includes("Leozinho"));
assert.ok(multiplos[2].observacao.includes("Situação:\nAgendado"));
assert.ok(!multiplos[2].observacao.includes("Autores dos gols"));
console.log("OK - três jogos isolados, em ordem e de competições/status diferentes");

const loteSelecionado = [multiplos[0], multiplos[2]].map(item => item.observacao);
assert.equal(loteSelecionado.length, 2);
assert.ok(loteSelecionado[0].includes("São Paulo"));
assert.ok(!loteSelecionado[0].includes("Azul"));
assert.ok(loteSelecionado[1].includes("Azul x Verde"));
assert.ok(!loteSelecionado[1].includes("São Paulo"));
console.log("OK - seleção individual e lote preservam customer_notes por partida");

assert.equal(__fotoJogosTest.schema.properties.jogos.items.properties.events.type, "array");
console.log("OK - schema esportivo estruturado");
