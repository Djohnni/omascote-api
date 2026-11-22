"use strict";

// TEST ONLY. Exercises real Express/body-parser/multer middleware in process.
// No listener, TCP connection, DNS lookup, fetch, or production transport.
const crypto = require("node:crypto");
const http = require("node:http");
const { Duplex } = require("node:stream");

function multipartBody({ fields = {}, files = [] } = {}) {
  const boundary = `omascote-test-${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];
  function quoted(value) {
    const text = String(value);
    if (/[\r\n"]/.test(text)) throw new TypeError("Invalid multipart test field/filename");
    return text;
  }
  for (const [name, values] of Object.entries(fields)) {
    for (const value of Array.isArray(values) ? values : [values]) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${String(value ?? "")}\r\n`));
    }
  }
  for (const file of files) {
    const field = quoted(file.field || file.name);
    const filename = quoted(file.filename || "fixture.bin");
    const contentType = String(file.contentType || "application/octet-stream");
    if (/[\r\n]/.test(contentType)) throw new TypeError("Invalid multipart test content type");
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || ""));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function injectRequest(app, options = {}) {
  const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
  let body;
  if (options.multipart) {
    const multipart = multipartBody(options.multipart);
    body = multipart.body;
    headers["content-type"] = multipart.contentType;
  } else if (options.json !== undefined) {
    body = Buffer.from(JSON.stringify(options.json));
    headers["content-type"] ||= "application/json";
  } else if (options.body !== undefined && options.body !== null) {
    if (Buffer.isBuffer(options.body)) body = options.body;
    else if (typeof options.body === "string") body = Buffer.from(options.body);
    else { body = Buffer.from(JSON.stringify(options.body)); headers["content-type"] ||= "application/json"; }
  } else body = Buffer.alloc(0);
  headers.host ||= "localhost.test";
  headers["content-length"] ??= String(body.length);

  return new Promise((resolve, reject) => {
    const responseChunks = [];
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); }
    });
    Object.defineProperties(socket, {
      remoteAddress: { value: options.remoteAddress || "127.0.0.1" },
      localAddress: { value: "127.0.0.1" },
      remotePort: { value: 49152 },
      localPort: { value: 80 }
    });
    const request = new http.IncomingMessage(socket);
    request.method = String(options.method || "GET").toUpperCase();
    request.url = options.path || options.url || "/";
    request.headers = headers;
    request.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
    request.httpVersion = "1.1";
    request.httpVersionMajor = 1;
    request.httpVersionMinor = 1;
    request.complete = true;

    const response = new http.ServerResponse(request);
    response.assignSocket(socket);
    const write = response.write.bind(response);
    const end = response.end.bind(response);
    const asBuffer = (value, encoding) => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, typeof encoding === "string" ? encoding : undefined);
    response.write = function (chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) responseChunks.push(asBuffer(chunk, encoding));
      return write(chunk, encoding, callback);
    };
    response.end = function (chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") responseChunks.push(asBuffer(chunk, encoding));
      return end(chunk, encoding, callback);
    };

    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`In-process request timed out: ${request.method} ${request.url}`)), options.timeoutMs || 10000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) { reject(error); return; }
      const resultBody = Buffer.concat(responseChunks);
      const text = resultBody.toString("utf8");
      let json;
      try { json = JSON.parse(text); } catch {}
      resolve({ status: response.statusCode, statusCode: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers: response.getHeaders(), body: resultBody, text, json });
    }
    response.once("finish", () => finish());
    response.once("error", finish);
    request.once("error", finish);
    socket.once("error", finish);
    request.push(body);
    request.push(null);
    try {
      if (typeof app.handle === "function") app.handle(request, response);
      else if (typeof app === "function") app(request, response);
      else finish(new TypeError("Expected an Express app or request handler"));
    } catch (error) { finish(error); }
  });
}

module.exports = { injectRequest, multipartBody };
