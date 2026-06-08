import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearAkvCachesForTest, createAzureKeyVaultProvider } from "../secrets/azure-keyvault-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

const VAULT_URI = "https://test-vault.vault.azure.net";

const previousEnv = {
  PAPERCLIP_SECRETS_AKV_TENANT_ID: process.env.PAPERCLIP_SECRETS_AKV_TENANT_ID,
  PAPERCLIP_SECRETS_AKV_CLIENT_ID: process.env.PAPERCLIP_SECRETS_AKV_CLIENT_ID,
  PAPERCLIP_SECRETS_AKV_CLIENT_SECRET: process.env.PAPERCLIP_SECRETS_AKV_CLIENT_SECRET,
};

function withSpCredentials() {
  process.env.PAPERCLIP_SECRETS_AKV_TENANT_ID = "test-tenant-id";
  process.env.PAPERCLIP_SECRETS_AKV_CLIENT_ID = "test-client-id";
  process.env.PAPERCLIP_SECRETS_AKV_CLIENT_SECRET = "test-client-secret";
}

function makeTokenResponse(token = "test-access-token") {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: 3600, token_type: "Bearer" }),
    { status: 200 },
  );
}

function makeSecretResponse(value: string, id?: string) {
  return new Response(
    JSON.stringify({
      value,
      id: id ?? `${VAULT_URI}/secrets/my-secret/abc123`,
      attributes: { enabled: true },
    }),
    { status: 200 },
  );
}

describe("azureKeyVaultProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _clearAkvCachesForTest();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("descriptor reports managed and external-reference capability", () => {
    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });
    const desc = provider.descriptor();
    expect(desc.id).toBe("azure_keyvault");
    expect(desc.supportsManagedValues).toBe(true);
    expect(desc.supportsExternalReferences).toBe(true);
  });

  it("healthCheck warns when SP credentials are missing", async () => {
    delete process.env.PAPERCLIP_SECRETS_AKV_TENANT_ID;
    delete process.env.PAPERCLIP_SECRETS_AKV_CLIENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AKV_CLIENT_SECRET;

    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });
    const result = await provider.healthCheck();
    expect(result.status).not.toBe("ok");
    expect(result.warnings?.some((w) => /AKV_TENANT_ID/i.test(w))).toBe(true);
  });

  it("resolves an external-reference secret via fetch (mocked)", async () => {
    withSpCredentials();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeSecretResponse("resolved-secret-value"));

    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });

    const linked = await provider.linkExternalSecret({ externalRef: "GhlApiToken" });
    const value = await provider.resolveVersion({
      material: linked.material,
      externalRef: linked.externalRef,
      providerVersionRef: null,
    });

    expect(value).toBe("resolved-secret-value");
  });

  it("does not leak plaintext in createSecret return material", async () => {
    withSpCredentials();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: `${VAULT_URI}/secrets/pclip-ns-company1-ghltok/ver001`, value: "super-secret" }),
          { status: 200 },
        ),
      );

    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "ns", secretNamePrefix: "pclip" },
    });

    const prepared = await provider.createSecret({
      value: "super-secret",
      context: {
        companyId: "company1",
        secretKey: "ghltok",
        secretName: "GHL API Token",
        version: 1,
      },
    });

    expect(JSON.stringify(prepared)).not.toContain("super-secret");
    expect(prepared.externalRef).toContain("pclip");
    expect(prepared.externalRef).toContain("ns");
    expect(prepared.externalRef).toContain("company1");
  });

  it("classifies 401 token error as access_denied", async () => {
    withSpCredentials();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "invalid_client", error_description: "AADSTS70011: bad client" }),
        { status: 401 },
      ),
    );

    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });

    await expect(
      provider.resolveVersion({
        material: { scheme: "azure_keyvault_v1", secretName: "MySecret", secretVersion: null, source: "external_reference" },
        externalRef: "MySecret",
        providerVersionRef: null,
      }),
    ).rejects.toBeInstanceOf(SecretProviderClientError);
  });

  it("classifies 404 secret-not-found as not_found", async () => {
    withSpCredentials();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "SecretNotFound", message: "A secret with name 'missing' was not found." } }),
          { status: 404 },
        ),
      );

    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });

    await expect(
      provider.resolveVersion({
        material: { scheme: "azure_keyvault_v1", secretName: "missing", secretVersion: null, source: "external_reference" },
        externalRef: "missing",
        providerVersionRef: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("linkExternalSecret stores name and null version without fetch", async () => {
    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });
    const linked = await provider.linkExternalSecret({ externalRef: "GhlApiToken", providerVersionRef: null });
    expect(linked.externalRef).toBe("GhlApiToken");
    expect(linked.providerVersionRef).toBeNull();
    expect(JSON.stringify(linked)).not.toContain("access_token");
  });

  it("deleteOrArchive skips deletion for external-reference secrets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createAzureKeyVaultProvider({
      providerConfig: { vaultUri: VAULT_URI, namespace: "test", secretNamePrefix: null },
    });
    await provider.deleteOrArchive({
      material: { scheme: "azure_keyvault_v1", secretName: "GhlApiToken", secretVersion: null, source: "external_reference" },
      externalRef: "GhlApiToken",
      mode: "delete",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
