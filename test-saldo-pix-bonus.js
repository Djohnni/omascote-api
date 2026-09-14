const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-saldo-pix-"));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.JWT_SECRET = "saldo-pix-test-secret-com-24-bytes";

const { __saldoPaymentTest } = require("./server");

test("aceita os creditos normais e os bonus dos pacotes Pix", () => {
  for (const credito of [8, 10, 18, 21, 28, 32, 48, 56]) {
    assert.equal(
      __saldoPaymentTest.validarCreditoSaldoMercadoPago(credito).ok,
      true,
      `credito ${credito} deveria ser aceito`
    );
  }

  for (const credito of [0, 9, 20, 55, 60, 61]) {
    assert.equal(
      __saldoPaymentTest.validarCreditoSaldoMercadoPago(credito).ok,
      false,
      `credito ${credito} deveria ser rejeitado`
    );
  }
});

test("reprocessa somente rejeicao antiga causada pela lista de pacotes", () => {
  assert.equal(
    __saldoPaymentTest.saldoRejeitadoPodeSerReprocessado({
      status: "credito_saldo_rejeitado",
      motivo: "credito_fora_dos_pacotes",
      credito: 56
    }),
    true
  );

  assert.equal(
    __saldoPaymentTest.saldoRejeitadoPodeSerReprocessado({
      status: "approved",
      credito: 56
    }),
    false
  );

  assert.equal(
    __saldoPaymentTest.saldoRejeitadoPodeSerReprocessado({
      status: "credito_saldo_rejeitado",
      motivo: "credito_acima_60",
      credito: 61
    }),
    false
  );
});

test("recuperacao aceita somente pagamento Pix aprovado com pacote e valores exatos", () => {
  const pagamento = {
    status: "approved",
    transaction_amount: 48,
    external_reference: "saldo_pix|conta69|saldo_4800|1789422171309",
    metadata: {
      tipo: "saldo",
      whatsapp: "conta69",
      pacote: "saldo_4800",
      credito: 56
    }
  };

  assert.deepEqual(
    __saldoPaymentTest.validarPagamentoPixSaldoParaRecuperacao(pagamento),
    {
      ok: true,
      whatsapp: "conta69",
      pacote: "saldo_4800",
      credito: 56,
      valor_pago: 48
    }
  );

  for (const alteracao of [
    { status: "pending" },
    { transaction_amount: 8 },
    { external_reference: "saldo_pix|outra|saldo_4800|1789422171309" },
    { metadata: { ...pagamento.metadata, credito: 55 } },
    { metadata: { ...pagamento.metadata, pacote: "saldo_invalido" } },
    { metadata: { ...pagamento.metadata, tipo: "pedido_pix" } }
  ]) {
    const candidato = {
      ...pagamento,
      ...alteracao,
      metadata: alteracao.metadata || pagamento.metadata
    };
    assert.equal(
      __saldoPaymentTest.validarPagamentoPixSaldoParaRecuperacao(candidato).ok,
      false
    );
  }
});
