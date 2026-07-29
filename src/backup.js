import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const MAX_BACKUPS = 14;

/**
 * Run a single database backup: checkpoint WAL, copy youfind.db → backups/youfind-YYYY-MM-DDTHH-MM.db
 * then prune old backups beyond MAX_BACKUPS.
 */
export function runBackup() {
  const dbPath = join(root, "youfind.db");
  const backupDir = join(root, "backups");

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  // Checkpoint WAL to ensure backup is consistent
  db.run("PRAGMA wal_checkpoint(TRUNCATE);");

  const date = new Date();
  const ts =
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}`;

  const dest = join(backupDir, `youfind-${ts}.db`);

  copyFileSync(dbPath, dest);
  console.log(`[Backup] Saved: ${dest}`);

  // Keep only the last MAX_BACKUPS backups
  const all = readdirSync(backupDir)
    .filter((f) => f.startsWith("youfind-") && f.endsWith(".db"))
    .sort()
    .reverse();

  if (all.length > MAX_BACKUPS) {
    for (const old of all.slice(MAX_BACKUPS)) {
      rmSync(join(backupDir, old));
      console.log(`[Backup] Pruned: ${old}`);
    }
  }

  console.log(`[Backup] Done. ${Math.min(all.length, MAX_BACKUPS)} backup(s) kept.`);
}
