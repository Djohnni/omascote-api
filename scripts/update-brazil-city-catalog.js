"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_STATE_CODES = Object.freeze([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO"
]);
const STATE_PREFIXES = Object.freeze({
  AC: "12", AL: "27", AP: "16", AM: "13", BA: "29", CE: "23", DF: "53",
  ES: "32", GO: "52", MA: "21", MT: "51", MS: "50", MG: "31", PA: "15",
  PB: "25", PR: "41", PE: "26", PI: "22", RJ: "33", RN: "24", RS: "43",
  RO: "11", RR: "14", SC: "42", SP: "35", SE: "28", TO: "17"
});

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return path.resolve(process.argv[index + 1]);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function parseDbf(buffer) {
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  let fieldStart = 1;
  for (let offset = 32; offset < headerLength - 1; offset += 32) {
    const terminator = buffer.indexOf(0, offset);
    const name = buffer.toString("ascii", offset, terminator);
    if (!name) break;
    const length = buffer[offset + 16];
    fields.push({ name, start: fieldStart, length });
    fieldStart += length;
  }
  const rows = [];
  for (let index = 0; index < recordCount; index += 1) {
    const offset = headerLength + (index * recordLength);
    if (buffer[offset] === 0x2a) continue;
    const row = {};
    for (const field of fields) {
      row[field.name] = buffer
        .toString("utf8", offset + field.start, offset + field.start + field.length)
        .trim();
    }
    rows.push(row);
  }
  return rows;
}

function polygonCentroid(buffer, offset, length) {
  const shapeType = buffer.readInt32LE(offset);
  if (shapeType === 0) return null;
  if (shapeType !== 5) throw new Error(`Unsupported shape type ${shapeType}`);
  if (length < 44) throw new Error("Invalid polygon record");
  const numParts = buffer.readInt32LE(offset + 36);
  const numPoints = buffer.readInt32LE(offset + 40);
  const partsOffset = offset + 44;
  const pointsOffset = partsOffset + (numParts * 4);
  if (pointsOffset + (numPoints * 16) > offset + length) throw new Error("Truncated polygon record");

  let crossSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (let part = 0; part < numParts; part += 1) {
    const start = buffer.readInt32LE(partsOffset + (part * 4));
    const end = part + 1 < numParts
      ? buffer.readInt32LE(partsOffset + ((part + 1) * 4))
      : numPoints;
    for (let point = start; point < end; point += 1) {
      const next = point + 1 < end ? point + 1 : start;
      const x1 = buffer.readDoubleLE(pointsOffset + (point * 16));
      const y1 = buffer.readDoubleLE(pointsOffset + (point * 16) + 8);
      const x2 = buffer.readDoubleLE(pointsOffset + (next * 16));
      const y2 = buffer.readDoubleLE(pointsOffset + (next * 16) + 8);
      const cross = (x1 * y2) - (x2 * y1);
      crossSum += cross;
      xSum += (x1 + x2) * cross;
      ySum += (y1 + y2) * cross;
    }
  }
  if (Math.abs(crossSum) < Number.EPSILON) {
    return {
      longitude: (buffer.readDoubleLE(offset + 4) + buffer.readDoubleLE(offset + 20)) / 2,
      latitude: (buffer.readDoubleLE(offset + 12) + buffer.readDoubleLE(offset + 28)) / 2
    };
  }
  return { longitude: xSum / (3 * crossSum), latitude: ySum / (3 * crossSum) };
}

function parseShp(buffer) {
  if (buffer.readInt32BE(0) !== 9994 || buffer.readInt32LE(28) !== 1000) {
    throw new Error("Invalid shapefile header");
  }
  const centroids = [];
  for (let offset = 100; offset < buffer.length;) {
    const contentLength = buffer.readInt32BE(offset + 4) * 2;
    centroids.push(polygonCentroid(buffer, offset + 8, contentLength));
    offset += 8 + contentLength;
  }
  return centroids;
}

function stateCodeOf(locality) {
  return locality.microrregiao?.mesorregiao?.UF?.sigla ||
    locality["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla || "";
}

function hasValidMunicipalCode(code, stateCode) {
  return /^\d{7}$/.test(code) && STATE_PREFIXES[stateCode] === code.slice(0, 2);
}

function fold(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

function validateCatalog(municipalities) {
  const codes = new Set();
  const names = new Set();
  const states = new Set();
  for (const item of municipalities) {
    if (!hasValidMunicipalCode(item[0], item[2])) throw new Error(`Invalid municipal code ${item[0]}`);
    if (codes.has(item[0])) throw new Error(`Duplicate municipal code ${item[0]}`);
    codes.add(item[0]);
    const nameKey = `${item[2]}:${fold(item[1])}`;
    if (names.has(nameKey)) throw new Error(`Duplicate city and state ${item[1]}/${item[2]}`);
    names.add(nameKey);
    states.add(item[2]);
    if (!Number.isFinite(item[3]) || item[3] < -90 || item[3] > 90) {
      throw new Error(`Invalid latitude for ${item[0]}`);
    }
    if (!Number.isFinite(item[4]) || item[4] < -180 || item[4] > 180) {
      throw new Error(`Invalid longitude for ${item[0]}`);
    }
  }
  if (municipalities.length !== 5571) throw new Error(`Expected 5571 municipalities, got ${municipalities.length}`);
  if (EXPECTED_STATE_CODES.some(code => !states.has(code)) || states.size !== EXPECTED_STATE_CODES.length) {
    throw new Error(`Incomplete state coverage: ${[...states].sort().join(",")}`);
  }
}

function main() {
  const localitiesPath = argument("localities");
  const meshArchivePath = argument("mesh-archive");
  const dbfPath = argument("dbf");
  const shpPath = argument("shp");
  const outputPath = argument("output");
  const localitiesBuffer = fs.readFileSync(localitiesPath);
  const meshArchiveBuffer = fs.readFileSync(meshArchivePath);
  const dbfBuffer = fs.readFileSync(dbfPath);
  const shpBuffer = fs.readFileSync(shpPath);
  const localities = JSON.parse(localitiesBuffer.toString("utf8"));
  const dbfRows = parseDbf(dbfBuffer);
  const centroids = parseShp(shpBuffer);
  if (dbfRows.length !== centroids.length) throw new Error("DBF and SHP record counts differ");

  const geometryByCode = new Map();
  for (let index = 0; index < dbfRows.length; index += 1) {
    geometryByCode.set(dbfRows[index].CD_MUN, centroids[index]);
  }
  const municipalities = localities.map(locality => {
    const code = String(locality.id);
    const geometry = geometryByCode.get(code);
    if (!geometry) throw new Error(`Missing geometry for ${code}`);
    return [
      code,
      String(locality.nome).normalize("NFC"),
      stateCodeOf(locality),
      Number(geometry.latitude.toFixed(6)),
      Number(geometry.longitude.toFixed(6))
    ];
  }).sort((left, right) => left[0].localeCompare(right[0]));
  validateCatalog(municipalities);

  const output = {
    metadata: {
      schema_version: 1,
      catalog_version: "IBGE-Localidades-current+MMD-2025",
      snapshot_date: "2026-08-26",
      municipality_count: municipalities.length,
      coordinate_reference_system: "SIRGAS 2000 (EPSG:4674)",
      coordinate_method: "signed polygon centroid rounded to 6 decimals",
      sources: [
        {
          name: "IBGE API de Localidades - Municipios",
          url: "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome",
          sha256: sha256(localitiesBuffer)
        },
        {
          name: "IBGE Malha Municipal Digital 2025",
          url: "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_municipais/municipio_2025/Brasil/BR_Municipios_2025.zip",
          archive_sha256: sha256(meshArchiveBuffer),
          dbf_sha256: sha256(dbfBuffer),
          shp_sha256: sha256(shpBuffer)
        }
      ]
    },
    municipalities
  };
  output.metadata.catalog_sha256 = sha256(Buffer.from(JSON.stringify(output.municipalities)));
  const finalSerialized = `${JSON.stringify(output)}\n`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, finalSerialized);
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    count: municipalities.length,
    states: [...new Set(municipalities.map(item => item[2]))].sort(),
    catalog_sha256: output.metadata.catalog_sha256,
    file_sha256: sha256(Buffer.from(finalSerialized))
  }, null, 2)}\n`);
}

main();
