"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { Transform, pipeline } = require("node:stream");

const HASH_CHUNK_SIZE = 64 * 1024;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function normalizeSha256(value) {
  const digest = String(value || "").trim().toLowerCase();
  return SHA256_HEX_PATTERN.test(digest) ? digest : "";
}

function setHashMetrics(file, details = {}) {
  if (!file || typeof file !== "object") return;
  file.content_sha256_source = String(details.source || "");
  file.content_sha256_cpu_ms = Math.max(0, Number(details.cpuMs || 0));
  file.content_sha256_elapsed_ms = Math.max(0, Number(details.elapsedMs || 0));
  file.content_sha256_bytes = Math.max(0, Number(details.bytes || 0));
  file.content_sha256_chunks = Math.max(0, Number(details.chunks || 0));
}

function hashUploadedFileBytes(file) {
  const cached = normalizeSha256(file?.content_sha256);
  if (cached) return cached;

  const hash = crypto.createHash("sha256");
  const startedAt = performance.now();
  let cpuMs = 0;
  let bytes = 0;
  let chunks = 0;

  const update = chunk => {
    const hashStartedAt = performance.now();
    hash.update(chunk);
    cpuMs += performance.now() - hashStartedAt;
    bytes += chunk.length;
    chunks += 1;
  };

  if (Buffer.isBuffer(file?.buffer)) {
    update(file.buffer);
  } else {
    if (!file?.path) {
      const error = new Error("Arquivo temporario indisponivel para hash.");
      error.code = "UPLOAD_HASH_FAILED";
      throw error;
    }

    let fd;
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
    let position = 0;

    try {
      fd = fs.openSync(file.path, "r");

      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        update(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
    } catch (cause) {
      const error = new Error("Nao foi possivel calcular o hash do upload.");
      error.code = "UPLOAD_HASH_FAILED";
      error.cause = cause;
      throw error;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
        }
      }
    }
  }

  const digest = hash.digest("hex");
  file.content_sha256 = digest;
  setHashMetrics(file, {
    source: Buffer.isBuffer(file?.buffer) ? "buffer_fallback" : "sync_file_fallback",
    cpuMs,
    elapsedMs: performance.now() - startedAt,
    bytes,
    chunks
  });
  return digest;
}

function groupUploadedFiles(files = {}) {
  const grouped = {};

  if (Array.isArray(files)) {
    for (const file of files.filter(Boolean)) {
      const field = String(file.fieldname || "");
      if (!grouped[field]) grouped[field] = [];
      grouped[field].push(file);
    }
    return grouped;
  }

  for (const [field, values] of Object.entries(files || {})) {
    grouped[field] = (Array.isArray(values) ? values : [values]).filter(Boolean);
  }

  return grouped;
}

function getUploadedFilesFingerprint(files = {}) {
  return Object.entries(groupUploadedFiles(files))
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .flatMap(([field, values]) => values.map((file, index) => ({
      field,
      index,
      mimetype: String(file.detected_mimetype || file.mimetype || "").toLowerCase(),
      size: Number(file.size || 0),
      sha256: hashUploadedFileBytes(file)
    })));
}

function resolveStorageOption(option, fallback) {
  if (typeof option === "function") return option;
  if (typeof option === "string") return (_req, _file, callback) => callback(null, option);
  return fallback;
}

function createHashingDiskStorage(options = {}) {
  const getDestination = resolveStorageOption(
    options.destination,
    (_req, _file, callback) => callback(null, process.cwd())
  );
  const getFilename = resolveStorageOption(
    options.filename,
    (_req, file, callback) => callback(null, path.basename(String(file.originalname || "upload.bin")))
  );
  const highWaterMark = Math.max(
    16 * 1024,
    Math.min(Number(options.highWaterMark || HASH_CHUNK_SIZE), 1024 * 1024)
  );

  return {
    _handleFile(req, file, callback) {
      getDestination(req, file, (destinationError, destination) => {
        if (destinationError) return callback(destinationError);

        getFilename(req, file, (filenameError, filename) => {
          if (filenameError) return callback(filenameError);

          try {
            fs.mkdirSync(destination, { recursive: true });
          } catch (error) {
            return callback(error);
          }

          const finalPath = path.join(destination, filename);
          const output = fs.createWriteStream(finalPath, { highWaterMark });
          const hash = crypto.createHash("sha256");
          const startedAt = performance.now();
          let cpuMs = 0;
          let size = 0;
          let chunks = 0;

          const hashingStream = new Transform({
            highWaterMark,
            transform(chunk, _encoding, done) {
              try {
                const hashStartedAt = performance.now();
                hash.update(chunk);
                cpuMs += performance.now() - hashStartedAt;
                size += chunk.length;
                chunks += 1;
                done(null, chunk);
              } catch (error) {
                done(error);
              }
            }
          });

          pipeline(file.stream, hashingStream, output, error => {
            if (error) {
              fs.unlink(finalPath, () => callback(error));
              return;
            }

            let digest;
            try {
              digest = hash.digest("hex");
            } catch (hashError) {
              fs.unlink(finalPath, () => callback(hashError));
              return;
            }

            callback(null, {
              destination,
              filename,
              path: finalPath,
              size,
              content_sha256: digest,
              content_sha256_source: "upload_stream",
              content_sha256_cpu_ms: cpuMs,
              content_sha256_elapsed_ms: performance.now() - startedAt,
              content_sha256_bytes: size,
              content_sha256_chunks: chunks
            });
          });
        });
      });
    },

    _removeFile(_req, file, callback) {
      const filePath = file.path;
      delete file.destination;
      delete file.filename;
      delete file.path;
      delete file.content_sha256;
      delete file.content_sha256_source;
      delete file.content_sha256_cpu_ms;
      delete file.content_sha256_elapsed_ms;
      delete file.content_sha256_bytes;
      delete file.content_sha256_chunks;
      fs.unlink(filePath, callback);
    }
  };
}

module.exports = {
  HASH_CHUNK_SIZE,
  createHashingDiskStorage,
  getUploadedFilesFingerprint,
  groupUploadedFiles,
  hashUploadedFileBytes,
  normalizeSha256
};
