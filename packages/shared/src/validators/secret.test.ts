import { describe, expect, it } from "vitest";
import {
  createSecretProviderConfigSchema,
  createSecretSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  secretProviderConfigPayloadSchema,
  updateSecretProviderConfigSchema,
} from "./secret.js";

describe("secret validators", () => {
  it("rejects externalRef on managed secrets", () => {
    expect(() =>
      createSecretSchema.parse({
        name: "OpenAI API Key",
        managedMode: "paperclip_managed",
        value: "secret-value",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
      }),
    ).toThrow(/Managed secrets cannot set externalRef/);
  });

  it("allows externalRef on external reference secrets", () => {
    const parsed = createSecretSchema.parse({
      name: "Shared Secret",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
    });

    expect(parsed.externalRef).toContain(":secret:shared/other");
  });

  it("accepts non-sensitive local and AWS provider vault metadata", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "local_encrypted",
        displayName: "Local",
        config: { backupReminderAcknowledged: true },
      }),
    ).not.toThrow();

    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "aws_secrets_manager",
        displayName: "AWS",
        config: {
          region: "us-east-1",
          namespace: "production",
          secretNamePrefix: "paperclip",
        },
      }),
    ).not.toThrow();
  });

  it("accepts origin-only Vault provider vault addresses", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "vault",
        displayName: "Vault draft",
        config: { address: " https://vault.example.com/ " },
      }),
    ).not.toThrow();

    const parsed = secretProviderConfigPayloadSchema.parse({
      provider: "vault",
      config: { address: " https://vault.example.com/ " },
    });

    expect(parsed.provider).toBe("vault");
    if (parsed.provider !== "vault") throw new Error("Expected vault provider payload");
    expect(parsed.config.address).toBe("https://vault.example.com");
  });

  it.each([
    "https://user:pass@vault.example.com",
    "https://vault.example.com?token=hvs.x",
    "https://vault.example.com#token=hvs.x",
    "https://vault.example.com/v1/secret",
  ])("rejects credential-bearing or non-origin Vault addresses: %s", (address) => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "vault",
        displayName: "Vault draft",
        config: { address },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("rejects unsafe Vault addresses in provider payload validation used by updates", () => {
    expect(() =>
      secretProviderConfigPayloadSchema.parse({
        provider: "vault",
        config: { address: "https://vault.example.com?client_token=hvs.x" },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("rejects unsafe Vault addresses in provider vault update payloads", () => {
    expect(() =>
      updateSecretProviderConfigSchema.parse({
        config: { address: "https://vault.example.com#token=hvs.x" },
      }),
    ).toThrow(/origin-only HTTP\(S\) URL/i);
  });

  it("validates AWS remote import preview and import payloads", () => {
    expect(
      remoteSecretImportPreviewSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        query: "openai",
        pageSize: 50,
      }),
    ).toEqual({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      query: "openai",
      pageSize: 50,
    });

    expect(
      remoteSecretImportSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "OPENAI_API_KEY",
            description: "  Operator-entered Paperclip description  ",
            providerMetadata: { name: "prod/openai" },
          },
        ],
      }),
    ).toMatchObject({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      secrets: [
        expect.objectContaining({
          key: "OPENAI_API_KEY",
          description: "Operator-entered Paperclip description",
        }),
      ],
    });
  });

  it("validates AWS provider vault discovery draft config without allowing sensitive keys", () => {
    expect(
      secretProviderConfigDiscoveryPreviewSchema.parse({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          namespace: "production",
          secretNamePrefix: "paperclip",
        },
        query: "paperclip",
        pageSize: 50,
      }),
    ).toEqual({
      provider: "aws_secrets_manager",
      config: {
        region: "us-east-1",
        namespace: "production",
        secretNamePrefix: "paperclip",
      },
      query: "paperclip",
      pageSize: 50,
    });

    expect(() =>
      secretProviderConfigDiscoveryPreviewSchema.parse({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          accessKeyId: "AKIA...",
        },
      }),
    ).toThrow(/sensitive field/i);
  });

  it("caps AWS remote import paging and row counts", () => {
    expect(() =>
      remoteSecretImportPreviewSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        pageSize: 101,
      }),
    ).toThrow();
    expect(() =>
      remoteSecretImportSchema.parse({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [],
      }),
    ).toThrow();
  });

  it("accepts valid Azure Key Vault provider vault config", () => {
    const parsed = secretProviderConfigPayloadSchema.parse({
      provider: "azure_keyvault",
      config: {
        vaultUri: "https://my-vault.vault.azure.net/",
        namespace: "production",
        secretNamePrefix: "paperclip",
      },
    });

    expect(parsed.provider).toBe("azure_keyvault");
    if (parsed.provider !== "azure_keyvault") throw new Error("Expected azure_keyvault provider payload");
    // trailing slash should be stripped
    expect(parsed.config.vaultUri).toBe("https://my-vault.vault.azure.net");
    expect(parsed.config.namespace).toBe("production");
    expect(parsed.config.secretNamePrefix).toBe("paperclip");
  });

  it("accepts Azure Key Vault provider vault config with only vaultUri", () => {
    expect(() =>
      createSecretProviderConfigSchema.parse({
        provider: "azure_keyvault",
        displayName: "ITO Key Vault",
        config: { vaultUri: "https://ito-msp-portal-dev-kv.vault.azure.net" },
      }),
    ).not.toThrow();
  });

  it.each([
    "https://my-vault.vault.azure.net/secrets/foo",
    "https://my-vault.vault.azure.net?code=abc",
    "https://my-vault.vault.azure.net#foo",
    "https://user:pass@my-vault.vault.azure.net",
    "https://my-vault.not-azure.net",
    "http://my-vault.vault.azure.net",
    "",
  ])("rejects invalid Azure Key Vault vaultUri: %s", (vaultUri) => {
    expect(() =>
      secretProviderConfigPayloadSchema.parse({
        provider: "azure_keyvault",
        config: { vaultUri },
      }),
    ).toThrow();
  });
});
