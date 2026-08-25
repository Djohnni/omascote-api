"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SOURCE_COMMIT = "89e45c6bc9ba2a9643c690ffffabd3c2449b7f3f";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function listFiles(root, directory = root) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${absolute}`);
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function buildManifest(root) {
  const files = listFiles(root).map(relativePath => {
    const content = fs.readFileSync(path.join(root, ...relativePath.split("/")));
    return Object.freeze({ path: relativePath, bytes: content.length, sha256: sha256(content) });
  });
  const treePayload = files.map(file => `${file.sha256}  ${file.path}\n`).join("");
  return Object.freeze({
    schema_version: 1,
    source_repository: "https://github.com/Djohnni/omascote.git",
    source_commit: SOURCE_COMMIT,
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    tree_sha256: sha256(Buffer.from(treePayload, "utf8")),
    files
  });
}

function git(repository, args, options = {}) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: options.encoding === undefined ? null : options.encoding,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`Git command failed: ${args[0]}`);
  return result.stdout;
}

function buildGitManifest(repository, commit = SOURCE_COMMIT) {
  const names = git(repository, ["ls-tree", "-r", "-z", "--name-only", commit])
    .toString("utf8").split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right, "en"));
  const files = names.map(relativePath => {
    const content = git(repository, ["show", `${commit}:${relativePath}`]);
    return Object.freeze({ path: relativePath, bytes: content.length, sha256: sha256(content) });
  });
  const treePayload = files.map(file => `${file.sha256}  ${file.path}\n`).join("");
  return Object.freeze({
    schema_version: 1,
    source_repository: "https://github.com/Djohnni/omascote.git",
    source_commit: commit,
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    tree_sha256: sha256(Buffer.from(treePayload, "utf8")),
    files
  });
}

function materializeGitSnapshot(repository, target, commit = SOURCE_COMMIT) {
  const names = git(repository, ["ls-tree", "-r", "-z", "--name-only", commit])
    .toString("utf8").split("\0").filter(Boolean);
  const resolvedTarget = path.resolve(target);
  if (path.basename(resolvedTarget) !== "snapshot" || path.basename(path.dirname(resolvedTarget)) !== "staging-frontend") {
    throw new Error("Unsafe staging snapshot target");
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  fs.mkdirSync(resolvedTarget, { recursive: true });
  for (const relativePath of names) {
    const absolute = path.resolve(resolvedTarget, ...relativePath.split("/"));
    if (!absolute.startsWith(`${resolvedTarget}${path.sep}`)) throw new Error("Unsafe source path");
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, git(repository, ["show", `${commit}:${relativePath}`]));
  }
  return names.length;
}

function main() {
  const repositoryRoot = path.resolve(__dirname, "..");
  const sourceRepository = path.resolve(process.argv[2] || path.join(repositoryRoot, "..", "frontend-release-candidate"));
  const snapshotRoot = path.join(repositoryRoot, "staging-frontend", "snapshot");
  const output = path.join(repositoryRoot, "staging-frontend", "source-manifest.json");
  if (process.argv.includes("--materialize")) materializeGitSnapshot(sourceRepository, snapshotRoot);
  const manifest = buildGitManifest(sourceRepository);
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${manifest.source_commit} ${manifest.file_count} ${manifest.tree_sha256}\n`);
}

if (require.main === module) main();

module.exports = {
  SOURCE_COMMIT,
  buildGitManifest,
  buildManifest,
  listFiles,
  materializeGitSnapshot,
  sha256
};
