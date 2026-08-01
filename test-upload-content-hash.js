"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const {
  createHashingDiskStorage,
  getUploadedFilesFingerprint,
  hashUploadedFileBytes
} = require("./src/orders/upload-content-hash");

function storeUpload(storage, directory, bytes, options = {}) {
  const originalname = options.originalname || "escudo.png";
  const fieldname = options.fieldname || "escudo1";
  const file = {
    fieldname,
    originalname,
    mimetype: options.mimetype || "image/png",
    stream: Readable.from([
      bytes.subarray(0, Math.ceil(bytes.length / 2)),
      bytes.subarray(Math.ceil(bytes.length / 2))
    ])
  };

  return new Promise((resolve, reject) => {
    storage._handleFile({}, file, (error, stored) => {
      if (error) return reject(error);
      resolve({ ...file, ...stored, destination: directory });
    });
  });
}

test("storage calcula SHA-256 durante o upload e o fingerprint reutiliza o digest", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-upload-hash-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  let sequence = 0;
  const storage = createHashingDiskStorage({
    destination: directory,
    filename: (_req, file, callback) => {
      sequence += 1;
      callback(null, `${sequence}-${file.originalname}`);
    }
  });
  const bytesA = Buffer.from("assinatura-a-com-mesmo-tamanho");
  const bytesB = Buffer.from("assinatura-b-com-mesmo-tamanho");
  assert.equal(bytesA.length, bytesB.length);

  const first = await storeUpload(storage, directory, bytesA);
  const second = await storeUpload(storage, directory, bytesB);

  assert.equal(first.content_sha256, crypto.createHash("sha256").update(bytesA).digest("hex"));
  assert.equal(second.content_sha256, crypto.createHash("sha256").update(bytesB).digest("hex"));
  assert.notEqual(first.content_sha256, second.content_sha256);
  assert.equal(first.content_sha256_source, "upload_stream");
  assert.equal(first.content_sha256_bytes, bytesA.length);
  assert.ok(first.content_sha256_chunks >= 1);
  assert.ok(first.content_sha256_cpu_ms >= 0);

  fs.unlinkSync(first.path);
  const fingerprintAfterRemoval = getUploadedFilesFingerprint({
    escudo1: [first]
  });
  assert.equal(
    fingerprintAfterRemoval[0].sha256,
    crypto.createHash("sha256").update(bytesA).digest("hex"),
    "o fingerprint deve usar o hash em cache sem reler o arquivo removido"
  );
});

test("bytes iguais ignoram nome e bytes diferentes com mesmos metadados divergem", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-upload-semantics-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  let sequence = 0;
  const storage = createHashingDiskStorage({
    destination: directory,
    filename: (_req, _file, callback) => callback(null, `${++sequence}.png`)
  });
  const equalBytes = Buffer.alloc(256 * 1024, 0x41);
  const differentBytes = Buffer.alloc(equalBytes.length, 0x42);

  const namedA = await storeUpload(storage, directory, equalBytes, {
    originalname: "primeiro.png"
  });
  const namedB = await storeUpload(storage, directory, equalBytes, {
    originalname: "segundo.png"
  });
  const sameMetadataDifferentBytes = await storeUpload(storage, directory, differentBytes, {
    originalname: "primeiro.png"
  });

  const hashA = getUploadedFilesFingerprint({ escudo1: [namedA] })[0].sha256;
  const hashB = getUploadedFilesFingerprint({ escudo1: [namedB] })[0].sha256;
  const hashDifferent = getUploadedFilesFingerprint({
    escudo1: [sameMetadataDifferentBytes]
  })[0].sha256;

  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashDifferent);
});

test("fallback de arquivo continua compativel e falha fechado sem bytes", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-upload-fallback-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const filePath = path.join(directory, "legacy.png");
  const bytes = Buffer.alloc(192 * 1024, 0x5a);
  fs.writeFileSync(filePath, bytes);
  const legacyFile = { path: filePath };

  assert.equal(
    hashUploadedFileBytes(legacyFile),
    crypto.createHash("sha256").update(bytes).digest("hex")
  );
  assert.equal(legacyFile.content_sha256_source, "sync_file_fallback");

  assert.throws(
    () => hashUploadedFileBytes({}),
    error => error?.code === "UPLOAD_HASH_FAILED"
  );
});
