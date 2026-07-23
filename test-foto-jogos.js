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

const casos = [
  {
    nome: "São Paulo x Athletico-PR",
    entrada: jogo({
      time_a: "São Paulo",
      time_b: "Athletico-PR",
      resultado_gols_a: "1",
      resultado_gols_b: "2",
      competicao: "Brasileirão Série A",
      status: "Encerrado",
      placar_final: "São Paulo 1 x 2 Athletico-PR",
      events: [
        { type: "goal", team: "São Paulo", player: "Artur Victor Guimarães", minute: "19'", details: "" },
        { type: "goal", team: "Athletico-PR", player: "Leozinho", minute: "46'", details: "" },
        { type: "goal", team: "Athletico-PR", player: "Leozinho", minute: "51'", details: "" }
      ]
    }),
    esperados: ["Brasileirão Série A", "São Paulo 1 x 2 Athletico-PR", "Encerrado", "Artur Victor Guimarães", "19'", "Leozinho", "46'", "51'"]
  },
  {
    nome: "somente confronto e horário",
    entrada: jogo({ horario: "20:30" }),
    esperados: ["Time A x Time B"],
    ausentes: ["Autores dos gols"]
  },
  {
    nome: "placar e autores",
    entrada: jogo({
      resultado_gols_a: "2",
      resultado_gols_b: "0",
      events: [{ type: "goal", team: "Time A", player: "Jogador Um", minute: "12'", details: "" }]
    }),
    esperados: ["Time A 2 x 0 Time B", "Jogador Um", "12'"]
  },
  {
    nome: "cartões",
    entrada: jogo({
      events: [{ type: "yellow_card", team: "Time B", player: "Atleta Dois", minute: "73'", details: "Cartão amarelo" }]
    }),
    esperados: ["Outros eventos", "yellow_card", "Atleta Dois", "73'", "Cartão amarelo"]
  },
  {
    nome: "disputa por pênaltis",
    entrada: jogo({ placar_tempo_normal: "1 x 1", placar_final: "1 x 1", disputa_penaltis: "Time A 5 x 4 Time B" }),
    esperados: ["Placar no tempo normal: 1 x 1", "Disputa por pênaltis: Time A 5 x 4 Time B"]
  },
  {
    nome: "texto parcialmente legível",
    entrada: jogo({ additional_information: ["Possível estádio municipal - confirmar."] }),
    esperados: ["Possível estádio municipal - confirmar."],
    ausentes: ["Inventado"]
  },
  {
    nome: "sem autores dos gols",
    entrada: jogo({ resultado_gols_a: "3", resultado_gols_b: "1", status: "Encerrado" }),
    esperados: ["Time A 3 x 1 Time B", "Encerrado"],
    ausentes: ["Autores dos gols"]
  }
];

for (const caso of casos) {
  const [saida] = __fotoJogosTest.normalizarRespostaJogosFoto({ jogos: [caso.entrada] });
  assert.ok(saida, `${caso.nome}: jogo descartado`);
  assert.ok(saida.observacao.length <= 1200, `${caso.nome}: excedeu 1.200 caracteres`);
  for (const esperado of caso.esperados || []) {
    assert.ok(saida.observacao.includes(esperado), `${caso.nome}: ausente "${esperado}"`);
  }
  for (const ausente of caso.ausentes || []) {
    assert.ok(!saida.observacao.includes(ausente), `${caso.nome}: dado indevido "${ausente}"`);
  }
  console.log(`OK - ${caso.nome}`);
}

assert.equal(__fotoJogosTest.schema.properties.jogos.items.properties.events.type, "array");
console.log("OK - schema esportivo estruturado");
