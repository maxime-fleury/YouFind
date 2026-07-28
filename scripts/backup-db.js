import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const dbPath = join(root, "youfind.db");
const backupDir = join(root, "backups");

if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

const date = new Date();
const ts =
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}`;

const dest = join(backupDir, `youfind-${ts}.db`);

copyFileSync(dbPath, dest);
console.log(`[Backup] Saved: ${dest}`);

// Keep only last 14 backups
const all = readdirSync(backupDir)
  .filter((f) => f.startsWith("youfind-") && f.endsWith(".db"))
  .sort()
  .reverse();

if (all.length > 14) {
  for (const old of all.slice(14)) {
    rmSync(join(backupDir, old));
    console.log(`[Backup] Pruned: ${old}`);
  }
}

console.log(`[Backup] Done. ${all.length > 14 ? "14" : all.length} backup(s) kept.`);
