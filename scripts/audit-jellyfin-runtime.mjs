#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const REPORT_ONLY = process.argv.includes("--report-only");
const INCLUDE_DOCS = process.argv.includes("--include-docs");
const INCLUDE_GENERATED = process.argv.includes("--include-generated");
const JSON_OUTPUT = process.argv.includes("--json");

const alwaysExcludedDirectories = new Set([".git", ".hermes", "node_modules"]);
const generatedDirectories = new Set(["dist", "public"]);
const includedExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const runtimeConfigurationNames = new Set([
  "Dockerfile",
  "package-lock.json",
  "package.json",
  "vercel.json",
  "vite.config.ts",
]);
const intentionallyNamedAuditFiles = new Set([
  "docs/jellyfin-parity-matrix.md",
  "docs/jellyfin-removal-plan.md",
  "docs/jellyfin-removal-verification.md",
  "docs/own-api-contract.md",
  "scripts/audit-jellyfin-runtime.mjs",
]);

const patterns = [
  ["jellyfin", /jellyfin/giu],
  ["JELLYFIN", /JELLYFIN/gu],
  ["legacy-port-8096", /\b8096\b/gu],
  ["legacy-port-8920", /\b8920\b/gu],
  ["X-Emby", /X-Emby/gu],
  ["PlaybackInfo", /PlaybackInfo/gu],
  ["MediaSource", /MediaSource/gu],
  ["RunTimeTicks", /RunTimeTicks/gu],
  ["UserData", /UserData/gu],
  ["SyncPlay", /SyncPlay/gu],
  ["ScheduledTasks", /ScheduledTasks/gu],
  ["legacy-Items-route", /["'`]\/Items(?:[/?"'`]|$)/gu],
  ["legacy-Users-route", /["'`]\/Users(?:[/?"'`]|$)/gu],
  ["legacy-Sessions-route", /["'`]\/Sessions(?:[/?"'`]|$)/gu],
  ["legacy-Videos-route", /["'`]\/Videos(?:[/?"'`]|$)/gu],
  ["legacy-Audio-route", /["'`]\/Audio(?:[/?"'`]|$)/gu],
  ["legacy-ScheduledTasks-route", /["'`]\/ScheduledTasks(?:[/?"'`]|$)/gu],
];

function isExcludedDirectory(directoryName) {
  return (
    alwaysExcludedDirectories.has(directoryName) ||
    (!INCLUDE_GENERATED && generatedDirectories.has(directoryName))
  );
}

function shouldInclude(relativePath) {
  const parts = relativePath.split("/");

  if (intentionallyNamedAuditFiles.has(relativePath)) {
    return false;
  }

  if (parts.some((part) => isExcludedDirectory(part))) {
    return false;
  }

  if (!INCLUDE_DOCS && (parts[0] === "docs" || relativePath === "README.md")) {
    return false;
  }

  const fileName = path.basename(relativePath);
  return (
    runtimeConfigurationNames.has(fileName) ||
    includedExtensions.has(path.extname(fileName))
  );
}

async function collectFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path
      .relative(ROOT, absolutePath)
      .split(path.sep)
      .join("/");

    if (entry.isDirectory()) {
      if (!isExcludedDirectory(entry.name)) {
        await collectFiles(absolutePath, result);
      }
      continue;
    }

    if (entry.isFile() && shouldInclude(relativePath)) {
      result.push({ absolutePath, relativePath });
    }
  }

  return result;
}

const files = await collectFiles(ROOT);
const findings = [];
const counts = Object.fromEntries(patterns.map(([name]) => [name, 0]));

for (const file of files) {
  const rawContent = await readFile(file.absolutePath, "utf8");
  const content =
    file.relativePath === "package.json"
      ? rawContent
          .split("\n")
          .filter((line) => !line.includes('"audit:jellyfin"'))
          .join("\n")
      : rawContent;
  const fileMatches = [];

  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern) ?? [];

    if (matches.length > 0) {
      counts[name] += matches.length;
      fileMatches.push({ pattern: name, count: matches.length });
    }
  }

  if (fileMatches.length > 0) {
    findings.push({ file: file.relativePath, matches: fileMatches });
  }
}

const totalMatches = Object.values(counts).reduce(
  (total, count) => total + count,
  0,
);
const includedScopes = ["runtime-source-and-config"];
if (INCLUDE_DOCS) {
  includedScopes.push("documentation");
}
if (INCLUDE_GENERATED) {
  includedScopes.push("generated-bundles");
}

const report = {
  scope: includedScopes.join(","),
  filesScanned: files.length,
  filesWithMatches: findings.length,
  totalMatches,
  counts,
  findings,
};

if (JSON_OUTPUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Jellyfin audit scope: ${report.scope}`);
  console.log(`Files scanned: ${report.filesScanned}`);
  console.log(`Files with matches: ${report.filesWithMatches}`);
  console.log(`Total matches: ${report.totalMatches}`);

  for (const finding of findings) {
    const summary = finding.matches
      .map(({ pattern, count }) => `${pattern}=${count}`)
      .join(", ");
    console.log(`${finding.file}: ${summary}`);
  }
}

if (!REPORT_ONLY && totalMatches > 0) {
  process.exitCode = 1;
}
