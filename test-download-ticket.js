const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DownloadTicketStore,
  attachmentContentDisposition,
  safeDownloadFilename
} = require("./src/download/download-ticket");

test("ticket is bound to user, resource type and resource id", () => {
  const store = new DownloadTicketStore();
  const issued = store.issue({
    resourceType: "pedido_resultado",
    resourceId: "pedido-1",
    userId: "cliente-1"
  });

  const wrongOrder = store.redeem(issued.token, {
    resourceType: "pedido_resultado",
    resourceId: "pedido-2"
  });
  assert.equal(wrongOrder.ok, false);
  assert.equal(wrongOrder.reason, "resource_mismatch");

  const redeemed = store.redeem(issued.token, {
    resourceType: "pedido_resultado",
    resourceId: "pedido-1"
  });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.record.userId, "cliente-1");
});

test("ticket can only be redeemed once", () => {
  const store = new DownloadTicketStore();
  const issued = store.issue({
    resourceType: "carta_imagem",
    resourceId: "carta-1",
    userId: "cliente-1"
  });

  assert.equal(store.redeem(issued.token, {
    resourceType: "carta_imagem",
    resourceId: "carta-1"
  }).ok, true);

  const reused = store.redeem(issued.token, {
    resourceType: "carta_imagem",
    resourceId: "carta-1"
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, "used");
});

test("expired and tampered tickets are rejected", () => {
  let now = 1_000;
  const store = new DownloadTicketStore({ ttlMs: 500, now: () => now });
  const issued = store.issue({
    resourceType: "pedido_resultado",
    resourceId: "pedido-1",
    userId: "cliente-1"
  });

  now = 1_501;
  const expired = store.redeem(issued.token, {
    resourceType: "pedido_resultado",
    resourceId: "pedido-1"
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "expired");

  const tampered = store.redeem(`${issued.token.slice(0, -1)}x`, {
    resourceType: "pedido_resultado",
    resourceId: "pedido-1"
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "invalid");
});

test("filenames are safe for Content-Disposition", () => {
  assert.equal(safeDownloadFilename("Arte São João 01.png"), "Arte_Sao_Joao_01.png");
  const header = attachmentContentDisposition("Arte São João 01.png");
  assert.match(header, /^attachment; filename="Arte_Sao_Joao_01\.png"/);
  assert.doesNotMatch(header, /[\r\n]/);
});
