#!/usr/bin/env node
// Backfill one-off : décode les entités HTML restées littérales dans
// articles.title / articles.summary (flux WordPress, cf. fix feed-parser).
// Le corps R2 est déjà décodé (linkedom) — rien à reprendre côté R2.
//
//   node scripts/backfill-decode-entities.mjs            # dry-run (génère le SQL)
//   node scripts/backfill-decode-entities.mjs --apply    # exécute en prod
//
// decodeHTML est sûr/idempotent : ne touche que les lignes réellement modifiées.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// `entities` est une dépendance de @boreas/shared (pas de la racine) : on la
// résout depuis son node_modules.
const require = createRequire(import.meta.url);
const entitiesPath = require.resolve("entities", {
  paths: [
    fileURLToPath(new URL("../packages/shared/node_modules", import.meta.url)),
  ],
});
const { decodeHTML } = await import(pathToFileURL(entitiesPath).href);

const DB = "boreas";
const CONFIG = "apps/api/wrangler.jsonc";
const SQL_FILE = "/tmp/backfill-entities.sql";
const APPLY = process.argv.includes("--apply");

const wrangler = (args) =>
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--config", CONFIG, ...args],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );

const raw = wrangler([
  "--json",
  "--command",
  "SELECT id, title, summary FROM articles WHERE title LIKE '%&%;%' OR summary LIKE '%&%;%'",
]);
const rows = JSON.parse(raw.slice(raw.indexOf("[")))[0].results;

const dec = (v) => (v === null || v === undefined ? null : decodeHTML(v));
const esc = (v) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

const updates = [];
for (const r of rows) {
  const t = dec(r.title);
  const s = dec(r.summary);
  if (t !== (r.title ?? null) || s !== (r.summary ?? null)) {
    updates.push({ id: r.id, t, s, oldTitle: r.title });
  }
}

console.log(`lignes candidates (LIKE) : ${rows.length}`);
console.log(`lignes réellement modifiées : ${updates.length}`);
for (const u of updates.slice(0, 10)) {
  console.log("  ", JSON.stringify(u.oldTitle), "→", JSON.stringify(u.t));
}

const sql = `${updates
  .map(
    (u) =>
      `UPDATE articles SET title=${esc(u.t)}, summary=${esc(u.s)} WHERE id=${esc(u.id)};`,
  )
  .join("\n")}\n`;
writeFileSync(SQL_FILE, sql);
console.log(`SQL écrit : ${SQL_FILE} (${updates.length} UPDATE)`);

if (!updates.length) {
  console.log("rien à faire.");
} else if (APPLY) {
  console.log(wrangler(["--file", SQL_FILE]));
  console.log("✅ APPLIQUÉ en prod.");
} else {
  console.log("DRY-RUN — relancer avec --apply pour exécuter.");
}
