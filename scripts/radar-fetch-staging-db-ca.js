"use strict";

const net = require("node:net");
const tls = require("node:tls");

let host = String(process.env.RADAR_DATABASE_TLS_HOST || "").trim().toLowerCase();
if (!host && process.env.RADAR_DATABASE_TLS_URL) {
  try {
    host = new URL(process.env.RADAR_DATABASE_TLS_URL).hostname.toLowerCase();
  } catch {
    host = "";
  }
}
if (!/^[a-z0-9-]+\.[a-z0-9.-]*render\.com$/.test(host)) {
  throw new Error("RADAR_DATABASE_TLS_HOST must be a Render PostgreSQL host");
}

function pem(raw) {
  const body = raw.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

const socket = net.connect(5432, host, () => {
  const request = Buffer.alloc(8);
  request.writeInt32BE(8, 0);
  request.writeInt32BE(80877103, 4);
  socket.write(request);
});

socket.once("data", chunk => {
  if (String.fromCharCode(chunk[0]) !== "S") {
    socket.destroy(new Error("PostgreSQL refused TLS"));
    return;
  }
  socket.pause();
  socket.removeAllListeners("data");
  const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
    let certificate = secure.getPeerCertificate(true);
    const fingerprints = new Set();
    const chain = [];
    while (certificate?.raw && !fingerprints.has(certificate.fingerprint256)) {
      fingerprints.add(certificate.fingerprint256);
      chain.push(pem(certificate.raw));
      if (!certificate.issuerCertificate || certificate.issuerCertificate === certificate) break;
      certificate = certificate.issuerCertificate;
    }
    process.stdout.write(chain.join("\n"));
    secure.end();
  });
  secure.on("error", error => {
    process.stderr.write(`TLS certificate retrieval failed: ${error.message}\n`);
    process.exitCode = 1;
  });
});

socket.on("error", error => {
  process.stderr.write(`TLS certificate retrieval failed: ${error.message}\n`);
  process.exitCode = 1;
});
