"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const context = require("../context");
const { newState } = require("./workflows");
const UUID = "[a-f0-9-]{36}";
const KEY_PATTERN = new RegExp(`^(?:${UUID}/state\\.json|${UUID}/files/${UUID}|shares/${UUID})$`);
const queues = new Map();

function storageRoot() {
  const root = context.getStore()?.storageRoot;
  if (!root) throw new Error("Armazenamento do atendimento indisponível.");
  return root;
}

function objectPath(root, key) {
  if (!KEY_PATTERN.test(key)) throw new Error("Arquivo inválido.");
  return path.join(root, ...key.split("/"));
}

async function atomicWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, filename);
}

function bucket() {
  const root = storageRoot();
  return {
    async get(key) {
      const filename = objectPath(root, key);
      let bytes;
      try { bytes = await fs.readFile(filename); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      let metadata = {};
      try { metadata = JSON.parse(await fs.readFile(`${filename}.metadata.json`, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return {
        body: bytes,
        httpMetadata: metadata.httpMetadata || {},
        customMetadata: metadata.customMetadata || {},
        async json() { return JSON.parse(bytes.toString("utf8")); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
      };
    },
    async head(key) {
      try { const stat = await fs.stat(objectPath(root, key)); return { size: stat.size }; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async put(key, value, options = {}) {
      const filename = objectPath(root, key);
      if (options.httpMetadata || options.customMetadata) {
        await atomicWrite(`${filename}.metadata.json`, JSON.stringify(options));
      }
      await atomicWrite(filename, typeof value === "string" ? value : Buffer.from(value));
    }
  };
}

function labSession(request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)omascote_lab=([a-f0-9-]{36})(?:;|$)/)?.[1]
    || crypto.randomUUID();
}

function headers() {
  // The public router binds the browser's session query to this internal request.
  return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

function localRequest(request) {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Origem do atendimento inválida.");
  }
}

async function voteKey(value) {
  return `vote-${crypto.createHash("sha256").update(value).digest("hex")}`;
}

async function readState(session) {
  const object = await bucket().get(`${session}/state.json`);
  const state = object ? await object.json() : newState();
  state.shareLinks ??= [];
  state.shareVotes ??= [];
  state.conversationId ??= "";
  state.conversationStartedAt ??= "";
  state.conversationStarts ??= [];
  state.conversations ??= [];
  state.chatRevision ??= 0;
  state.draftRevision ??= 0;
  state.processed ??= [];
  state.shareVotes = await Promise.all(state.shareVotes.map(value => value.includes(":") ? voteKey(value) : value));
  state.processed = await Promise.all(state.processed.map(value => /^vote-[a-f0-9-]{73}$/.test(value) ? voteKey(value) : value));
  for (const ticket of state.tickets) ticket.files ??= [];
  for (const order of state.orders) {
    if (order.status === "generating" && order.generationStartedAt && Date.now() - new Date(order.generationStartedAt).getTime() > 360_000) {
      order.status = "failed";
      order.error = "A geração anterior foi interrompida. O pedido está salvo e pode ser tentado novamente.";
    }
  }
  return state;
}

async function mutate(session, fn) {
  const root = storageRoot();
  const queueKey = `${root}:${session}`;
  const previous = queues.get(queueKey) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const result = await fn(await readState(session));
    await bucket().put(`${session}/state.json`, JSON.stringify(result.state));
    return result.value;
  });
  queues.set(queueKey, next);
  try { return await next; }
  finally { if (queues.get(queueKey) === next) queues.delete(queueKey); }
}

module.exports = { bucket, headers, labSession, localRequest, mutate, readState, voteKey };
