#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const BASELINE_PATH = path.join(REPO_ROOT, "security", "integrity.baseline.json");

const EXCLUDED_DIRS = new Set([".git", "node_modules"]);
const EXCLUDED_FILES = new Set([
  "security/integrity.baseline.json",
]);

const ML_FEATURES = [
  { name: "dynamic_eval", weight: 5, pattern: /\beval\s*\(/i },
  { name: "new_function", weight: 5, pattern: /\bnew\s+Function\s*\(/i },
  { name: "string_timeout", weight: 4, pattern: /set(Time|Interval)out?\s*\(\s*['"`]/i },
  { name: "obfuscated_eval", weight: 4, pattern: /\be\s*v\s*a\s*l\s*\(/i },
  { name: "cookie_access", weight: 2, pattern: /document\.cookie/i },
  { name: "storage_access", weight: 1, pattern: /(localStorage|sessionStorage)\./i },
  { name: "script_injection", weight: 3, pattern: /<\s*script\b/i },
  { name: "inline_handlers", weight: 2, pattern: /\bon\w+\s*=\s*['"]/i },
  { name: "js_scheme", weight: 5, pattern: /javascript\s*:/i },
  { name: "meta_refresh", weight: 4, pattern: /http-equiv\s*=\s*['"]refresh['"]/i },
  { name: "window_redirect", weight: 4, pattern: /(window\.|document\.)?location\s*(\.href)?\s*=\s*['"`]/i },
  { name: "top_redirect", weight: 4, pattern: /top\.location\s*=\s*['"`]/i },
  { name: "external_script", weight: 2, pattern: /<\s*script[^>]+src\s*=\s*['"]https?:\/\//i },
  { name: "honeypot_marker", weight: 1, pattern: /(companySite|honeypot|trap_field|bot_field)/i },
];

const HIGH_RISK_THRESHOLD = 6;

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...(await walkFiles(absPath)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.has(relPath)) continue;
    files.push(relPath);
  }

  return files.sort();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function readFileSafe(relPath) {
  const absPath = path.join(REPO_ROOT, relPath);
  return fs.readFile(absPath);
}

function scoreContent(contentText) {
  let score = 0;
  const matched = [];

  for (const feature of ML_FEATURES) {
    if (feature.pattern.test(contentText)) {
      score += feature.weight;
      matched.push(feature.name);
    }
  }

  return { score, matched, blocked: score >= HIGH_RISK_THRESHOLD };
}

function parseArgs(argv) {
  return {
    writeBaseline: argv.includes("--write-baseline"),
    strictIntegrity: argv.includes("--strict-integrity"),
  };
}

async function writeBaseline() {
  const files = await walkFiles(REPO_ROOT);
  const hashes = {};

  for (const relPath of files) {
    const content = await readFileSafe(relPath);
    hashes[relPath] = sha256(content);
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: hashes,
  };

  await fs.writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Baseline written: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
}

async function loadBaseline() {
  const raw = await fs.readFile(BASELINE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.files || typeof parsed.files !== "object") {
    throw new Error("Baseline is invalid: missing files object.");
  }
  return parsed;
}

async function runGuard(strictIntegrity) {
  const baseline = await loadBaseline();
  const currentFiles = await walkFiles(REPO_ROOT);
  const currentSet = new Set(currentFiles);
  const baselineFiles = Object.keys(baseline.files).sort();
  const baselineSet = new Set(baselineFiles);

  const added = currentFiles.filter((f) => !baselineSet.has(f));
  const removed = baselineFiles.filter((f) => !currentSet.has(f));

  const changed = [];
  const blocked = [];

  for (const relPath of currentFiles) {
    const content = await readFileSafe(relPath);
    const hash = sha256(content);
    const baselineHash = baseline.files[relPath];

    if (!baselineHash || baselineHash !== hash) {
      changed.push(relPath);
      const text = content.toString("utf8");
      const result = scoreContent(text);
      if (result.blocked) {
        blocked.push({ relPath, score: result.score, matched: result.matched });
      }
    }
  }

  const integrityDrift = added.length > 0 || removed.length > 0 || changed.length > 0;

  if (added.length) console.log(`Added files: ${added.join(", ")}`);
  if (removed.length) console.log(`Removed files: ${removed.join(", ")}`);
  if (changed.length) console.log(`Changed files: ${changed.join(", ")}`);

  if (blocked.length) {
    console.error("\n⛔ Tiny-ML Guard blocked high-risk changes:");
    for (const item of blocked) {
      console.error(` - ${item.relPath} | score=${item.score} | features=${item.matched.join(",")}`);
    }
    process.exitCode = 2;
    return;
  }

  if (strictIntegrity && integrityDrift) {
    console.error("\n⛔ Integrity drift detected in strict mode.");
    process.exitCode = 3;
    return;
  }

  console.log("✅ Tiny-ML Guard passed.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.writeBaseline) {
    await writeBaseline();
    return;
  }

  await runGuard(args.strictIntegrity);
}

main().catch((error) => {
  console.error(`Guard error: ${error.message}`);
  process.exitCode = 1;
});
