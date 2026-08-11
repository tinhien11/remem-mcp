import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Backup the database and audit log to a timestamped directory. */
export function backup(dbPath: string, auditPath: string, outputDir: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir =
    outputDir === "-" ? join(dirname(dbPath), "backups", timestamp) : join(outputDir, timestamp);

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  let copied = 0;

  // Copy the database file
  if (existsSync(dbPath)) {
    const dbBackup = join(backupDir, basename(dbPath));
    copyFileSync(dbPath, dbBackup);
    copied++;
    console.log(`  Database: ${dbBackup}`);
  } else {
    console.log(`  Database: not found at ${dbPath}`);
  }

  // Copy WAL and SHM files if they exist
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) {
    copyFileSync(walPath, join(backupDir, `${basename(dbPath)}-wal`));
    copied++;
  }
  if (existsSync(shmPath)) {
    copyFileSync(shmPath, join(backupDir, `${basename(dbPath)}-shm`));
    copied++;
  }

  // Copy the audit log
  if (existsSync(auditPath)) {
    const auditBackup = join(backupDir, basename(auditPath));
    copyFileSync(auditPath, auditBackup);
    copied++;
    console.log(`  Audit log: ${auditBackup}`);
  }

  console.log(`\nBackup complete: ${copied} file(s) copied to ${backupDir}`);
}
