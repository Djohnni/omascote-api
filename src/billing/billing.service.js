function hasMascoteUniformeGift(categoria, cliente) {
  return false;
}

function normalizeBalanceValue(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    // Valores com virgula exigem migracao explicita antes de virarem saldo.
    if (trimmed.includes(",")) return 0;

    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function getBalanceFields(cliente = {}) {
  const source = cliente && typeof cliente === "object" ? cliente : {};
  const saldo_mensal = normalizeBalanceValue(source.saldo_mensal);
  const saldo_extra = normalizeBalanceValue(source.saldo_extra);

  return {
    saldo_mensal,
    saldo_extra,
    saldo: Number((saldo_mensal + saldo_extra).toFixed(2))
  };
}

function getAvailableBalance(cliente) {
  return getBalanceFields(cliente).saldo;
}

function hasEnoughBalance(cliente, custoPedido) {
  return getAvailableBalance(cliente) >= custoPedido;
}

function ensureCurrentBillingCycle(cliente, mesAtual) {
  if (cliente.ciclo_mes !== mesAtual) {
    cliente.ciclo_mes = mesAtual;
    cliente.usados_no_ciclo = 0;
  }

  return cliente;
}

function formatInsufficientBalanceMessage(custoPedido) {
  return `Saldo insuficiente. Este pedido custa R$ ${custoPedido.toFixed(2).replace(".", ",")}`;
}

function applyOrderCharge(cliente, { custoPedido, mesAtual, temBrindeMascote }) {
  let restante = custoPedido;

  const saldoExtraAtual = Number(cliente.saldo_extra || 0);
  const descontoExtra = Math.min(saldoExtraAtual, restante);
  cliente.saldo_extra = Number((saldoExtraAtual - descontoExtra).toFixed(2));
  restante = Number((restante - descontoExtra).toFixed(2));

  if (restante > 0) {
    const saldoMensalAtual = Number(cliente.saldo_mensal || 0);
    cliente.saldo_mensal = Number(Math.max(0, saldoMensalAtual - restante).toFixed(2));
  }

  cliente.usados_no_ciclo = (cliente.usados_no_ciclo || 0) + 1;
  cliente.ciclo_mes = mesAtual;

  if (temBrindeMascote) {
    cliente.brinde_mascote_disponivel = false;
    cliente.brinde_mascote_usado_em = new Date().toISOString();
  }

  return cliente;
}

module.exports = {
  hasMascoteUniformeGift,
  normalizeBalanceValue,
  getBalanceFields,
  getAvailableBalance,
  hasEnoughBalance,
  ensureCurrentBillingCycle,
  formatInsufficientBalanceMessage,
  applyOrderCharge
};
