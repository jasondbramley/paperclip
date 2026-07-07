import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSecretProviders, listSecretProviders } from "../secrets/provider-registry.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";

describe("secret provider registry", () => {
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const previousFallbackFiles = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FALLBACK_FILES;
  const tmpDirs: string[] = [];

  afterEach(() => {
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    if (previousMasterKey === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    }
    if (previousFallbackFiles === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FALLBACK_FILES;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FALLBACK_FILES = previousFallbackFiles;
    }
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes managed and external-reference provider capabilities", () => {
    const descriptors = listSecretProviders();

    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_encrypted",
          supportsManagedValues: true,
          supportsExternalReferences: false,
          configured: true,
        }),
        expect.objectContaining({
          id: "aws_secrets_manager",
          supportsManagedValues: true,
          supportsExternalReferences: true,
          configured: false,
        }),
        expect.objectContaining({
          id: "azure_keyvault",
          supportsManagedValues: true,
          supportsExternalReferences: true,
        }),
      ]),
    );
  });

  it("warns when the local encrypted key file is readable by group or others", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, "master.key");
    writeFileSync(keyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o644 });
    chmodSync(keyFile, 0o644);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;

    const checks = await checkSecretProviders();
    const local = checks.find((check) => check.provider === "local_encrypted");

    expect(local).toMatchObject({
      status: "warn",
      details: { keyFilePath: keyFile },
    });
    expect(local?.warnings?.join("\n")).toContain("chmod 600");
    expect(local?.backupGuidance?.join("\n")).toContain("database");
  });

  it("recovers local encrypted material with a configured fallback key file", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const originalKeyFile = path.join(dir, "original.key");
    const currentKeyFile = path.join(dir, "current.key");
    writeFileSync(originalKeyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    writeFileSync(currentKeyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = originalKeyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FALLBACK_FILES;

    const prepared = await localEncryptedProvider.createSecret({
      value: "runtime-secret",
      providerConfig: null,
      context: {
        companyId: "company-1",
        secretKey: "api-key",
        secretName: "API key",
        version: 1,
      },
    });

    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = currentKeyFile;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FALLBACK_FILES = originalKeyFile;

    await expect(localEncryptedProvider.resolveVersion({
      material: prepared.material,
      externalRef: null,
      providerVersionRef: null,
      providerConfig: null,
      context: {
        companyId: "company-1",
        secretKey: "api-key",
        secretName: "API key",
        version: 1,
      },
    })).resolves.toBe("runtime-secret");
  });

  it("reports an actionable local encrypted recovery error when no configured key matches", async () => {
    const dir = path.join(os.tmpdir(), `paperclip-secret-provider-${randomBytes(6).toString("hex")}`);
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const originalKeyFile = path.join(dir, "original.key");
    const currentKeyFile = path.join(dir, "current.key");
    writeFileSync(originalKeyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    writeFileSync(currentKeyFile, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = originalKeyFile;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FALLBACK_FILES;

    const prepared = await localEncryptedProvider.createSecret({
      value: "runtime-secret",
      providerConfig: null,
      context: {
        companyId: "company-1",
        secretKey: "api-key",
        secretName: "API key",
        version: 1,
      },
    });

    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = currentKeyFile;

    await expect(localEncryptedProvider.resolveVersion({
      material: prepared.material,
      externalRef: null,
      providerVersionRef: null,
      providerConfig: null,
      context: {
        companyId: "company-1",
        secretKey: "api-key",
        secretName: "API key",
        version: 1,
      },
    })).rejects.toThrow(/Restore the original secrets\/master\.key/);
  });
});
