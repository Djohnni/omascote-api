"use strict";

const path = require("node:path");
const context = require("./runtime/context");
const handlers = Object.fromEntries(["assistant", "files", "lab", "read-print", "share"].map(name => [
  name, require(`./runtime/routes/${name}`)
]));
const MAX_BODY_BYTES = 13 * 1024 * 1024;

function createLocalAtendimentoTransport(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || path.join(process.env.OMASCOTE_DATA_DIR || "dados", "atendimento"));
  return async (target, init = {}) => {
    const url = new URL(target);
    const route = url.pathname.replace(/^\/api\//, "");
    const handler = handlers[route]?.[init.method || "GET"];
    if (!handler) return Response.json({ ok: false, error: "Recurso não encontrado." }, { status: 404 });
    let body = init.body;
    if (body && typeof body !== "string" && !Buffer.isBuffer(body)) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of body) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) return Response.json({ ok: false, error: "Envio muito grande." }, { status: 413 });
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const request = new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
      method: init.method || "GET",
      headers: init.headers,
      ...(body === undefined ? {} : { body })
    });
    return context.run({ storageRoot }, () => handler(request));
  };
}

module.exports = { createLocalAtendimentoTransport };
