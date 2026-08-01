import { mkdirSync, readdirSync, rmSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const MAX_BACKUPS = 14;

/**
 * Run a consistent SQLite backup using VACUUM INTO, then prune old backups.
 * The native SQLite copy includes the current WAL state and cannot produce a
 * partially-copied main database while the application is writing.
 */
export function runBackup() {
  const backupDir = join(root, "backups");

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const date = new Date();
  const ts =
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(date.getSeconds()).padStart(2, "0")}-${String(date.getMilliseconds()).padStart(3, "0")}`;

  const dest = join(backupDir, `youfind-${ts}.db`);
  if (existsSync(dest)) {
    throw new Error(`Backup destination already exists: ${dest}`);
  }

  // VACUUM INTO creates a consistent standalone database, including data that
  // is currently represented in the WAL. The path is generated locally, but
  // escape it defensively before embedding it in SQLite's filename literal.
  const escapedDest = dest.replaceAll("'", "''");
  db.run(`VACUUM INTO '${escapedDest}'`);

  if (!existsSync(dest) || statSync(dest).size === 0) {
    throw new Error(`Backup was not created: ${dest}`);
  }
  console.log(`[Backup] Saved: ${dest}`);

  // Keep only the last MAX_BACKUPS backups
  const all = readdirSync(backupDir)
    // Keep manually-created CLI/final snapshots; prune only scheduled backups.
    .filter((f) => /^youfind-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}(?:-\d{2}(?:-\d{3})?)?\.db$/.test(f))
    .sort()
    .reverse();

  if (all.length > MAX_BACKUPS) {
    for (const old of all.slice(MAX_BACKUPS)) {
      rmSync(join(backupDir, old));
      console.log(`[Backup] Pruned: ${old}`);
    }
  }

  console.log(`[Backup] Done. ${Math.min(all.length, MAX_BACKUPS)} backup(s) kept.`);
  return dest;
}
