import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbRestoreCommand } from "../commands/db-restore.js";

const mocks = vi.hoisted(() => ({
  runDatabaseRestore: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/db", () => ({
  runDatabaseRestore: mocks.runDatabaseRestore,
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    message: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  confirm: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
}));

const ORIGINAL_ENV = { ...process.env };

function createBackupFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-restore-cli-"));
  const file = path.join(dir, "paperclip-restore.sql");
  fs.writeFileSync(file, "SELECT 1;\n", "utf8");
  return file;
}

describe("dbRestoreCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("restores from DATABASE_URL without requiring a connection string option", async () => {
    const backupFile = createBackupFile();
    process.env.DATABASE_URL = "postgres://paperclip:secret-value@db.example.com:5432/paperclip";

    await dbRestoreCommand(backupFile, {
      yes: true,
      connectTimeoutSeconds: 9,
    });

    expect(mocks.runDatabaseRestore).toHaveBeenCalledWith({
      connectionString: process.env.DATABASE_URL,
      backupFile,
      connectTimeoutSeconds: 9,
    });
  });
});
