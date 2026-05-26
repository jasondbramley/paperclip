import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { runDatabaseRestore } from "@paperclipai/db";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

type DbRestoreOptions = {
  config?: string;
  connectTimeoutSeconds?: number;
  yes?: boolean;
  json?: boolean;
};

function resolveConnectionString(configPath?: string): { value: string; source: string } {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return { value: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return {
    value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

function resolveBackupFile(rawPath: string): string {
  const backupFile = path.resolve(rawPath);
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file does not exist: ${backupFile}`);
  }
  const stat = fs.statSync(backupFile);
  if (!stat.isFile()) {
    throw new Error(`Backup path is not a file: ${backupFile}`);
  }
  if (!backupFile.endsWith(".sql") && !backupFile.endsWith(".sql.gz")) {
    throw new Error("Backup file must end with .sql or .sql.gz");
  }
  return backupFile;
}

function normalizeConnectTimeoutSeconds(value: number | undefined): number {
  const candidate = value ?? 5;
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new Error(`Invalid connect timeout '${String(candidate)}'. Use a positive integer.`);
  }
  return candidate;
}

export async function dbRestoreCommand(backupFileArg: string, opts: DbRestoreOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip db:restore ")));

  const configPath = resolveConfigPath(opts.config);
  const connection = resolveConnectionString(opts.config);
  const backupFile = resolveBackupFile(backupFileArg);
  const connectTimeoutSeconds = normalizeConnectTimeoutSeconds(opts.connectTimeoutSeconds);

  p.log.message(pc.dim(`Config: ${configPath}`));
  p.log.message(pc.dim(`Connection source: ${connection.source}`));
  p.log.message(pc.dim(`Backup file: ${backupFile}`));

  if (!opts.yes) {
    const confirmed = await p.confirm({
      message: "Restore this backup into the configured database? Existing objects may be replaced.",
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Restore cancelled.");
      return;
    }
  }

  const spinner = p.spinner();
  spinner.start("Restoring database backup...");
  try {
    await runDatabaseRestore({
      connectionString: connection.value,
      backupFile,
      connectTimeoutSeconds,
    });
    spinner.stop("Restore completed.");

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            backupFile,
            connectionSource: connection.source,
            connectTimeoutSeconds,
          },
          null,
          2,
        ),
      );
    }
    p.outro(pc.green("Database restore completed."));
  } catch (err) {
    spinner.stop(pc.red("Restore failed."));
    throw err;
  }
}
