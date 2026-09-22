const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-art-prepayment-"));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.JWT_SECRET = "art-prepayment-test-secret";
process.env.NODE_ENV = "test";

const { __artPrepaymentTest: prepayment } = require("./server");

function pendingOrder(extra = {}) {
  return {
    pagamento_pendente: true,
    valor_pendente: 8,
    ...extra
  };
}

test("toda arte cobravel exige Pix antes da criacao", () => {
  assert.deepEqual(prepayment.decidirPagamentoAntesDaCriacao({
    valor: 8,
    cobertoPeloPlano: false,
    temSaldoDisponivel: false
  }), {
    pagamento_antecipado_obrigatorio: true,
    tem_saldo_suficiente: false,
    demonstracao_apos_pagamento: false
  });
});

test("saldo existente nao envia uma arte cobravel para producao sem Pix", () => {
  assert.deepEqual(prepayment.decidirPagamentoAntesDaCriacao({
    valor: 8,
    cobertoPeloPlano: false,
    temSaldoDisponivel: true
  }), {
    pagamento_antecipado_obrigatorio: true,
    tem_saldo_suficiente: false,
    demonstracao_apos_pagamento: false
  });
});

test("uma arte paga anteriormente nao cria demonstracao gratuita", () => {
  assert.equal(
    prepayment.decidirPagamentoAntesDaCriacao({
      valor: 8,
      cobertoPeloPlano: false,
      temSaldoDisponivel: false
    }).pagamento_antecipado_obrigatorio,
    true
  );
});

test("beneficio gratuito ou cota ja paga nao exige um novo Pix", () => {
  assert.equal(
    prepayment.decidirPagamentoAntesDaCriacao({
      valor: 0,
      cobertoPeloPlano: false,
      temSaldoDisponivel: true
    }).pagamento_antecipado_obrigatorio,
    false
  );
  assert.equal(
    prepayment.decidirPagamentoAntesDaCriacao({
      valor: 8,
      cobertoPeloPlano: true,
      temSaldoDisponivel: false
    }).pagamento_antecipado_obrigatorio,
    false
  );
});

test("pedido pendente com pre-pagamento nao entra na fila antes do Pix", () => {
  assert.equal(
    prepayment.pedidoAguardandoPagamentoParaCriacao(pendingOrder({
      pagamento_previo_obrigatorio: true,
      modalidade_criacao: "com_suporte"
    })),
    true
  );

  assert.equal(
    prepayment.pedidoAguardandoPagamentoParaCriacao({
      ...pendingOrder({ pagamento_previo_obrigatorio: true }),
      pagamento_pendente: false,
      pagamento_confirmado_em: "2026-09-22T05:00:00.000Z"
    }),
    false
  );
});
