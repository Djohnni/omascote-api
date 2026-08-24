"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { RadarIdentityError } = require("./radar-identity.errors");

const FORMATS = Object.freeze({
  jpeg: Object.freeze({ mime: "image/jpeg", extensions: new Set([".jpg", ".jpeg"]) }),
  png: Object.freeze({ mime: "image/png", extensions: new Set([".png"]) }),
  webp: Object.freeze({ mime: "image/webp", extensions: new Set([".webp"]) })
});

function imageError(code, status, message) {
  return new RadarIdentityError(code, status, message);
}

function detectSignature(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) return "webp";
  return null;
}

function isAnimatedImage(buffer, format) {
  if (format === "webp") {
    for (let offset = 12; offset + 8 <= buffer.length;) {
      const chunk = buffer.toString("ascii", offset, offset + 4);
      const length = buffer.readUInt32LE(offset + 4);
      if (chunk === "ANIM" || chunk === "ANMF") return true;
      if (chunk === "VP8X" && length >= 1 && offset + 8 < buffer.length) {
        if ((buffer[offset + 8] & 0x02) !== 0) return true;
      }
      offset += 8 + length + (length % 2);
    }
  }
  if (format === "png") {
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      const chunk = buffer.toString("ascii", offset + 4, offset + 8);
      if (chunk === "acTL") return true;
      offset += 12 + length;
    }
  }
  return false;
}

function eraseBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

async function processProfilePrintImage(file, config) {
  if (!file?.path) {
    throw imageError("PROFILE_PRINT_IMAGE_REQUIRED", 400, "Envie uma imagem no campo imagem.");
  }

  const extension = path.extname(String(file.originalname || "")).toLowerCase();
  const announcedMime = String(file.mimetype || "").toLowerCase();
  let original;
  try {
    original = await fs.readFile(file.path);
    if (original.length === 0 || original.length > config.profilePrintMaxFileBytes) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_TOO_LARGE",
        413,
        "A imagem excede o limite permitido."
      );
    }

    const signatureFormat = detectSignature(original);
    const formatPolicy = signatureFormat ? FORMATS[signatureFormat] : null;
    if (
      !formatPolicy ||
      announcedMime !== formatPolicy.mime ||
      !formatPolicy.extensions.has(extension)
    ) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_TYPE_INVALID",
        415,
        "Envie uma imagem PNG, JPEG ou WebP valida."
      );
    }
    if (isAnimatedImage(original, signatureFormat)) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_ANIMATED",
        400,
        "Imagens animadas nao sao aceitas."
      );
    }

    let metadata;
    try {
      metadata = await sharp(original, {
        failOn: "error",
        limitInputPixels: config.profilePrintMaxPixels,
        sequentialRead: true
      }).metadata();
    } catch {
      throw imageError(
        "PROFILE_PRINT_IMAGE_INVALID",
        400,
        "A imagem esta corrompida ou nao pode ser processada."
      );
    }

    if (metadata.format !== signatureFormat) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_TYPE_INVALID",
        415,
        "O conteudo da imagem nao corresponde ao formato informado."
      );
    }
    if (Number(metadata.pages || 1) !== 1) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_ANIMATED",
        400,
        "Imagens animadas nao sao aceitas."
      );
    }

    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (!width || !height || width > config.profilePrintMaxWidth || height > config.profilePrintMaxHeight) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_DIMENSIONS_INVALID",
        400,
        "As dimensoes da imagem estao fora do limite permitido."
      );
    }
    if (width * height > config.profilePrintMaxPixels) {
      throw imageError(
        "PROFILE_PRINT_IMAGE_DIMENSIONS_INVALID",
        400,
        "A imagem possui pixels demais para processamento seguro."
      );
    }

    let pipeline = sharp(original, {
      failOn: "error",
      limitInputPixels: config.profilePrintMaxPixels,
      sequentialRead: true
    }).rotate().toColourspace("srgb");
    if (signatureFormat === "jpeg") {
      pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true });
    } else if (signatureFormat === "png") {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    } else {
      pipeline = pipeline.webp({ quality: 90, effort: 4 });
    }

    let output;
    try {
      output = await pipeline.toBuffer({ resolveWithObject: true });
    } catch {
      throw imageError(
        "PROFILE_PRINT_IMAGE_INVALID",
        400,
        "A imagem esta corrompida ou nao pode ser processada."
      );
    }
    if (!output?.data?.length || output.data.length > config.profilePrintMaxFileBytes) {
      eraseBuffer(output?.data);
      throw imageError(
        "PROFILE_PRINT_IMAGE_TOO_LARGE",
        413,
        "A imagem processada excede o limite permitido."
      );
    }

    return Object.freeze({
      buffer: output.data,
      format: signatureFormat,
      mimeType: formatPolicy.mime,
      width: Number(output.info.width),
      height: Number(output.info.height),
      originalSizeBytes: original.length,
      sanitizedSizeBytes: output.data.length,
      byteHash: crypto.createHash("sha256").update(original).digest("hex")
    });
  } finally {
    eraseBuffer(original);
  }
}

module.exports = {
  FORMATS,
  detectSignature,
  isAnimatedImage,
  eraseBuffer,
  processProfilePrintImage
};
