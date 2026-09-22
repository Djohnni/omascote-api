const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-demo-cycle-"));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.JWT_SECRET = "demo-payment-cycle-test-secret";
process.env.NODE_ENV = "test";

const { __demoPaymentCycleTest: cycle } = require("./server");

function paidOrder(method = "pix") {
  return {
    pagamento_pendente: false,
    pagamento_metodo: method,
    pagamento_confirmado_em: "2026-09-21T20:00:00.000Z",
    valor_final: 8,
    pagamento_info: { valor_pago: 8, status: "approved" }
  };
}

function pendingOrder(extra = {}) {
  return {
    pagamento_pendente: true,
    valor_pendente: 8,
    ...extra
  };
}

test("primeira arte sem pagamento anterior ainda nao possui direito a demonstracao", () => {
  const state = cycle.avaliarCicloDemonstracao([]);
  assert.deepEqual(state, {
    possui_pagamento_real: false,
    pedido_pendente: null,
    pedido_pendente_id: ""
  });
  assert.deepEqual(cycle.decidirCicloDemonstracaoCriacao({
    valor: 8,
    cobertoPeloPlano: false,
    temSaldoDisponivel: false,
    pedidoAssistente: false,
    modalidadeCriacao: "com_suporte",
    cicloDemonstracao: state
  }), {
    primeira_arte_exige_pix: true,
    pagamento_antecipado_obrigatorio: true,
    tem_saldo_suficiente: false,
    demonstracao_apos_pagamento: false
  });
});

test("Pix e saldo pago liberam uma demonstracao, mas cupom e plano nao", () => {
  assert.equal(
    cycle.avaliarCicloDemonstracao([{ id: "pix-1", pedido: paidOrder("pix") }])
      .possui_pagamento_real,
    true
  );
  assert.equal(
    cycle.avaliarCicloDemonstracao([{ id: "saldo-1", pedido: paidOrder("saldo_ia4tube") }])
      .possui_pagamento_real,
    true
  );

  for (const metodo of ["cupom", "brinde_app", "plano_semanal"]) {
    assert.equal(
      cycle.avaliarCicloDemonstracao([{ pedido: paidOrder(metodo) }])
        .possui_pagamento_real,
      false,
      `${metodo} nao deve liberar demonstracao`
    );
  }
});

test("uma arte pendente bloqueia a segunda demonstracao mesmo depois de outro Pix", () => {
  const pendente = pendingOrder({ motivo_pagamento_pendente: "saldo_insuficiente" });
  const state = cycle.avaliarCicloDemonstracao([
    { id: "demo-pendente", pedido: pendente },
    { id: "pix-pago-depois", pedido: paidOrder("pix") }
  ]);

  assert.equal(state.possui_pagamento_real, true);
  assert.equal(state.pedido_pendente, pendente);
  assert.equal(state.pedido_pendente_id, "demo-pendente");
  assert.equal(cycle.deveBloquearNovaArtePorDemonstracaoPendente({
    valor: 8,
    pedidoAssistente: false,
    modalidadeCriacao: "com_suporte",
    cicloDemonstracao: state
  }), true);
});

test("pagamento anterior transforma exatamente o proximo pedido sem saldo em demonstracao", () => {
  const state = cycle.avaliarCicloDemonstracao([
    { id: "pix-pago", pedido: paidOrder("pix") }
  ]);
  assert.deepEqual(cycle.decidirCicloDemonstracaoCriacao({
    valor: 8,
    cobertoPeloPlano: false,
    temSaldoDisponivel: false,
    pedidoAssistente: false,
    modalidadeCriacao: "com_suporte",
    cicloDemonstracao: state
  }), {
    primeira_arte_exige_pix: false,
    pagamento_antecipado_obrigatorio: false,
    tem_saldo_suficiente: false,
    demonstracao_apos_pagamento: true
  });
});

test("pedido inicial marcado para pre-pagamento nao entra na fila antes do Pix", () => {
  assert.equal(
    cycle.pedidoAguardandoPagamentoParaCriacao(pendingOrder({
      pagamento_previo_obrigatorio: true,
      modalidade_criacao: "com_suporte"
    })),
    true
  );

  assert.equal(
    cycle.pedidoAguardandoPagamentoParaCriacao({
      ...pendingOrder({ pagamento_previo_obrigatorio: true }),
      pagamento_pendente: false,
      pagamento_confirmado_em: "2026-09-21T20:00:00.000Z"
    }),
    false
  );
});

test("pendencia sem valor nao bloqueia uma nova demonstracao", () => {
  const state = cycle.avaliarCicloDemonstracao([{
    id: "gratuito",
    pedido: pendingOrder({ valor_pendente: 0 })
  }]);

  assert.equal(state.pedido_pendente, null);
  assert.equal(state.pedido_pendente_id, "");
});
