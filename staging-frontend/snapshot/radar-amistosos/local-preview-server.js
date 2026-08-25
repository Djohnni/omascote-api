"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = Math.min(Math.max(Number(process.env.RADAR_LOCAL_PREVIEW_PORT || 4190), 1024), 65535);
const host = "127.0.0.1";

function apiOrigin() {
  const value = String(process.env.OMASCOTE_LOCAL_API_BASE || "").trim();
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !new Set(["127.0.0.1", "localhost"]).has(parsed.hostname)) {
    throw new Error("OMASCOTE_LOCAL_API_BASE must be an explicit local HTTP origin");
  }
  return parsed.origin;
}

const localApi = apiOrigin();
const types = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp"
});

function localAppHtml() {
  return fs.readFileSync(path.join(root, "app.html"), "utf8")
    .replace(
      '<meta name="omascote-api-base" content="https://api.omascote.com.br">',
      `<meta name="omascote-api-base" content="${localApi}">`
    )
    .replace(
      '<meta name="omascote-environment" content="production">',
      '<meta name="omascote-environment" content="local-real">'
    );
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  const pathname = url.pathname === "/" ? "/app.html" : url.pathname;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const relative = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`) || relative.startsWith(".git")) {
    response.writeHead(404);
    response.end();
    return;
  }

  try {
    const app = target === path.join(root, "app.html");
    const body = app ? Buffer.from(localAppHtml(), "utf8") : fs.readFileSync(target);
    response.writeHead(200, {
      "Content-Type": types[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Radar-Preview": "local-real"
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Radar real local em http://${host}:${port}/app.html\n`);
});
