import { createHash } from "node:crypto";
import type { DeploymentMode } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

const AKV_SCHEME = "azure_keyvault_v1";
const AKV_API_VERSION = "7.4";
const AKV_RESOURCE = "https://vault.azure.net";
const AKV_REQUEST_TIMEOUT_MS = 20_000;
const AKV_TOKEN_EXPIRY_SKEW_MS = 60_000;
const AKV_SECRET_CACHE_TTL_MS = 10_000;

interface AkvMaterial extends StoredSecretVersionMaterial {
  scheme: typeof AKV_SCHEME;
  secretName: string;
  secretVersion: string | null;
  source: "managed" | "external_reference";
}

interface AkvProviderConfig {
  vaultUri: string;
  namespace: string;
  secretNamePrefix: string | null;
}

interface AkvTokenCache {
  token: string;
  expiresAt: number;
  pending: Promise<string> | null;
}

interface AkvSecretCacheEntry {
  value: string;
  expiresAt: number;
}

// Per-vault-URI token cache
const tokenCache = new Map<string, AkvTokenCache>();
// Per-vault-URI+secret+version resolved value cache (short TTL)
const secretValueCache = new Map<string, AkvSecretCacheEntry>();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getAkvAuthConfig(): { tenantId: string; clientId: string; clientSecret: string } | null {
  const tenantId = process.env.PAPERCLIP_SECRETS_AKV_TENANT_ID?.trim();
  const clientId = process.env.PAPERCLIP_SECRETS_AKV_CLIENT_ID?.trim();
  const clientSecret = process.env.PAPERCLIP_SECRETS_AKV_CLIENT_SECRET?.trim();
  if (tenantId && clientId && clientSecret) {
    return { tenantId, clientId, clientSecret };
  }
  return null;
}

function getAkvConfigReadiness() {
  const auth = getAkvAuthConfig();
  const missingConfig: string[] = [];
  if (!auth) {
    const tenantId = process.env.PAPERCLIP_SECRETS_AKV_TENANT_ID?.trim();
    const clientId = process.env.PAPERCLIP_SECRETS_AKV_CLIENT_ID?.trim();
    const clientSecret = process.env.PAPERCLIP_SECRETS_AKV_CLIENT_SECRET?.trim();
    if (!tenantId) missingConfig.push("PAPERCLIP_SECRETS_AKV_TENANT_ID");
    if (!clientId) missingConfig.push("PAPERCLIP_SECRETS_AKV_CLIENT_ID");
    if (!clientSecret) missingConfig.push("PAPERCLIP_SECRETS_AKV_CLIENT_SECRET");
  }
  return { missingConfig, hasServicePrincipal: Boolean(auth) };
}

async function acquireAkvToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const endpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${AKV_RESOURCE}/.default`,
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(AKV_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Azure token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const errorDesc = String(parsed.error_description ?? parsed.error ?? response.statusText);
    throw new Error(`Azure token acquisition failed: ${errorDesc}`);
  }
  const token = asOptionalNonEmptyString(parsed.access_token);
  if (!token) throw new Error("Azure token endpoint returned empty access_token");
  return token;
}

async function getAccessToken(vaultUri: string): Promise<string> {
  const auth = getAkvAuthConfig();
  if (!auth) {
    throw unprocessable(
      "Azure Key Vault provider requires service principal credentials: " +
      "PAPERCLIP_SECRETS_AKV_TENANT_ID, PAPERCLIP_SECRETS_AKV_CLIENT_ID, PAPERCLIP_SECRETS_AKV_CLIENT_SECRET",
    );
  }
  const now = Date.now();
  let cached = tokenCache.get(vaultUri);
  if (!cached) {
    cached = { token: "", expiresAt: 0, pending: null };
    tokenCache.set(vaultUri, cached);
  }
  if (cached.token && cached.expiresAt > now) return cached.token;
  if (cached.pending) return cached.pending;

  cached.pending = (async () => {
    const response = await fetch(
      `https://login.microsoftonline.com/${auth.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: auth.clientId,
          client_secret: auth.clientSecret,
          scope: `${AKV_RESOURCE}/.default`,
        }).toString(),
        signal: AbortSignal.timeout(AKV_REQUEST_TIMEOUT_MS),
      },
    );
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Azure token endpoint returned non-JSON response`);
    }
    if (!response.ok) {
      const errDesc = String(parsed.error_description ?? parsed.error ?? "unknown");
      const code = classifyAkvError(errDesc);
      throw new SecretProviderClientError({
        code,
        provider: "azure_keyvault",
        operation: "acquireToken",
        message: akvSafeMessage(code),
        rawMessage: errDesc,
      });
    }
    const token = asOptionalNonEmptyString(parsed.access_token);
    if (!token) throw new Error("Azure token endpoint returned empty access_token");
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
    if (cached) {
      cached.token = token;
      cached.expiresAt = now + expiresIn * 1000 - AKV_TOKEN_EXPIRY_SKEW_MS;
    }
    return token;
  })().finally(() => {
    if (cached) cached.pending = null;
  });

  return cached.pending;
}

function classifyAkvError(message: string): SecretProviderClientErrorCode {
  if (/Unauthorized|401|invalid_client|AADSTS7000[0-9]/i.test(message)) return "access_denied";
  if (/Forbidden|403|does not have.*permission|Access denied/i.test(message)) return "access_denied";
  if (/404|SecretNotFound|not found/i.test(message)) return "not_found";
  if (/409|Conflict/i.test(message)) return "conflict";
  if (/429|TooManyRequests|throttl/i.test(message)) return "throttled";
  if (/400|BadParameter|invalid/i.test(message)) return "invalid_request";
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|timeout/i.test(message)) return "provider_unavailable";
  return "provider_error";
}

function akvSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied": return "Azure Key Vault denied the request. Check service principal permissions for this vault.";
    case "not_found": return "Azure Key Vault could not find the requested secret.";
    case "conflict": return "Azure Key Vault reported a conflict.";
    case "throttled": return "Azure Key Vault throttled the request. Wait and try again.";
    case "invalid_request": return "Azure Key Vault rejected the request.";
    case "provider_unavailable": return "Azure Key Vault is unreachable right now.";
    default: return "Azure Key Vault request failed.";
  }
}

function normalizeAkvError(operation: string, error: unknown): never {
  if (error instanceof SecretProviderClientError) throw error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const code = classifyAkvError(rawMessage);
  throw new SecretProviderClientError({
    code,
    provider: "azure_keyvault",
    operation,
    message: akvSafeMessage(code),
    rawMessage,
    cause: error,
  });
}

async function akvRequest<T>(input: {
  vaultUri: string;
  method: "GET" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}): Promise<T> {
  const token = await getAccessToken(input.vaultUri);
  const url = `${input.vaultUri}${input.path}${input.path.includes("?") ? "&" : "?"}api-version=${AKV_API_VERSION}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method: input.method,
    headers,
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(AKV_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(text.slice(0, 400));
    }
  }

  if (!response.ok) {
    const err = parsed.error as Record<string, unknown> | undefined;
    const rawMessage = String(err?.message ?? err?.code ?? response.statusText ?? "unknown");
    const code = classifyAkvError(`${response.status} ${rawMessage}`);
    throw new SecretProviderClientError({
      code,
      provider: "azure_keyvault",
      operation: input.path.split("/")[2] ?? "request",
      message: akvSafeMessage(code),
      rawMessage,
    });
  }

  return parsed as T;
}

function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): AkvProviderConfig {
  if (input.provider !== "azure_keyvault") {
    throw unprocessable("Azure Key Vault provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("Azure Key Vault provider vault is disabled");
  }
  const vaultUri = asOptionalNonEmptyString(input.config.vaultUri);
  if (!vaultUri) {
    throw unprocessable("Azure Key Vault provider vault requires config: vaultUri");
  }
  return {
    vaultUri: vaultUri.replace(/\/+$/, ""),
    namespace: sanitizeSegment(asOptionalNonEmptyString(input.config.namespace) ?? input.id),
    secretNamePrefix: asOptionalNonEmptyString(input.config.secretNamePrefix),
  };
}

function sanitizeSegment(input: string): string {
  return input.trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildManagedSecretName(config: AkvProviderConfig, context: Pick<SecretProviderWriteContext, "companyId" | "secretKey"> | undefined): string {
  if (!context) throw unprocessable("Azure Key Vault provider requires write context for managed secrets");
  const parts: string[] = [];
  if (config.secretNamePrefix) parts.push(sanitizeSegment(config.secretNamePrefix));
  parts.push(sanitizeSegment(config.namespace));
  parts.push(sanitizeSegment(context.companyId));
  parts.push(sanitizeSegment(context.secretKey));
  return parts.filter(Boolean).join("-");
}

function buildExternalRefMaterial(externalRef: string, secretVersion: string | null): PreparedSecretVersion {
  const normalizedRef = externalRef.trim();
  const normalizedVersion = secretVersion?.trim() || null;
  const fingerprint = sha256Hex(`${AKV_SCHEME}:${normalizedRef}:${normalizedVersion ?? ""}`);
  return {
    material: {
      scheme: AKV_SCHEME,
      secretName: normalizedRef,
      secretVersion: normalizedVersion,
      source: "external_reference",
    },
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: normalizedRef,
    providerVersionRef: normalizedVersion,
  };
}

function asAkvMaterial(value: StoredSecretVersionMaterial): AkvMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === AKV_SCHEME &&
    typeof value.secretName === "string" &&
    (typeof value.secretVersion === "string" || value.secretVersion === null) &&
    (value.source === "managed" || value.source === "external_reference")
  ) {
    return value as AkvMaterial;
  }
  throw unprocessable("Invalid Azure Key Vault material");
}

function canLoadConfig(): boolean {
  return getAkvConfigReadiness().missingConfig.length === 0;
}

export function createAzureKeyVaultProvider(options?: {
  providerConfig?: AkvProviderConfig;
}): SecretProviderModule {
  function resolveConfig(input?: SecretProviderVaultRuntimeConfig | null): AkvProviderConfig {
    if (input) return readProviderVaultConfig(input);
    if (options?.providerConfig) return options.providerConfig;
    throw unprocessable(
      "Azure Key Vault provider requires a provider vault config with vaultUri",
    );
  }

  async function validateConfig(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    const readiness = getAkvConfigReadiness();
    if (!input?.providerConfig) {
      // Check global config if no per-vault config
      if (readiness.missingConfig.length > 0) {
        warnings.push(`Azure Key Vault provider is missing env: ${readiness.missingConfig.join(", ")}`);
      }
    }
    return { ok: readiness.missingConfig.length === 0, warnings };
  }

  async function healthCheck(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderHealthCheck> {
    const readiness = getAkvConfigReadiness();
    const warnings: string[] = [];

    if (!readiness.hasServicePrincipal) {
      for (const m of readiness.missingConfig) warnings.push(`Missing required env: ${m}`);
    }

    if (!input?.providerConfig) {
      return {
        provider: "azure_keyvault",
        status: readiness.missingConfig.length > 0 ? "warn" : "ok",
        message: readiness.missingConfig.length > 0
          ? `Azure Key Vault provider is not fully configured: missing ${readiness.missingConfig.join(", ")}`
          : "Azure Key Vault provider is configured. Set vaultUri in a provider vault config to activate.",
        warnings,
        details: {
          hasServicePrincipal: readiness.hasServicePrincipal,
          missingEnv: readiness.missingConfig,
        },
      };
    }

    try {
      const config = resolveConfig(input.providerConfig);
      // Probe: list first page of secrets to verify connectivity + permissions
      await akvRequest<unknown>({
        vaultUri: config.vaultUri,
        method: "GET",
        path: "/secrets?maxresults=1",
      });
      return {
        provider: "azure_keyvault",
        status: warnings.length > 0 ? "warn" : "ok",
        message: "Azure Key Vault connectivity verified.",
        warnings,
        details: {
          vaultUri: config.vaultUri,
          hasServicePrincipal: readiness.hasServicePrincipal,
        },
        backupGuidance: [
          "Rotate the Paperclip service principal secret in Azure AD when required.",
          "Back up the Paperclip DB alongside KV secrets — the DB stores the external ref names.",
        ],
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      return {
        provider: "azure_keyvault",
        status: "error",
        message: `Azure Key Vault health check failed: ${rawMessage}`,
        warnings,
        details: {
          hasServicePrincipal: readiness.hasServicePrincipal,
        },
      };
    }
  }

  return {
    id: "azure_keyvault",
    descriptor() {
      return {
        id: "azure_keyvault",
        label: "Azure Key Vault",
        requiresExternalRef: false,
        supportsManagedValues: true,
        supportsExternalReferences: true,
        configured: canLoadConfig(),
      };
    },
    validateConfig,
    async createSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const secretName = buildManagedSecretName(config, input.context);
      const valueSha256 = sha256Hex(input.value);
      try {
        const result = await akvRequest<{ id: string; value: string }>(
          {
            vaultUri: config.vaultUri,
            method: "PUT",
            path: `/secrets/${encodeURIComponent(secretName)}`,
            body: { value: input.value },
          },
        );
        const urlParts = result.id?.split("/secrets/")[1]?.split("/") ?? [];
        const versionId = urlParts[1] ?? null;
        return {
          material: {
            scheme: AKV_SCHEME,
            secretName,
            secretVersion: versionId,
            source: "managed",
          },
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: secretName,
          providerVersionRef: versionId,
        };
      } catch (error) {
        normalizeAkvError("createSecret", error);
      }
    },
    async createVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const secretName = input.externalRef?.trim() ?? buildManagedSecretName(config, input.context);
      const valueSha256 = sha256Hex(input.value);
      try {
        const result = await akvRequest<{ id: string; value: string }>(
          {
            vaultUri: config.vaultUri,
            method: "PUT",
            path: `/secrets/${encodeURIComponent(secretName)}`,
            body: { value: input.value },
          },
        );
        const urlParts = result.id?.split("/secrets/")[1]?.split("/") ?? [];
        const versionId = urlParts[1] ?? null;
        return {
          material: {
            scheme: AKV_SCHEME,
            secretName,
            secretVersion: versionId,
            source: "managed",
          },
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: secretName,
          providerVersionRef: versionId,
        };
      } catch (error) {
        normalizeAkvError("createVersion", error);
      }
    },
    async linkExternalSecret(input) {
      return buildExternalRefMaterial(input.externalRef, input.providerVersionRef ?? null);
    },
    async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
      const config = resolveConfig(input.providerConfig);
      const pageSize = input.pageSize && Number.isFinite(input.pageSize)
        ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
        : 25;
      const query = input.query?.trim().toLowerCase();
      try {
        interface AkvListResponse {
          value?: Array<{ id: string; attributes?: Record<string, unknown> }>;
          nextLink?: string;
        }
        const path = input.nextToken
          ? input.nextToken
          : `/secrets?maxresults=${pageSize}`;
        const result = await akvRequest<AkvListResponse>({
          vaultUri: config.vaultUri,
          method: "GET",
          path,
        });
        const entries = (result.value ?? []).map((entry) => {
          const parts = entry.id?.split("/secrets/") ?? [];
          const namePart = parts[1] ?? entry.id ?? "";
          const name = namePart.split("/")[0] ?? namePart;
          return { externalRef: name, name };
        });
        const filtered = query
          ? entries.filter((e) => e.name.toLowerCase().includes(query))
          : entries;
        // Strip vault URI prefix from nextLink to use as nextToken
        const nextToken = result.nextLink
          ? result.nextLink.replace(config.vaultUri, "").split("?")[1]
            ? `/secrets?${result.nextLink.split("?")[1] ?? ""}`
            : null
          : null;
        return {
          secrets: filtered.map((e) => ({
            externalRef: e.externalRef,
            name: e.name,
            providerVersionRef: null,
          })),
          nextToken,
        };
      } catch (error) {
        normalizeAkvError("listRemoteSecrets", error);
      }
    },
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const material = asAkvMaterial(input.material);
      const secretName = input.externalRef?.trim() ?? material.secretName;
      const secretVersion = input.providerVersionRef?.trim() ?? material.secretVersion ?? null;

      const cacheKey = `${config.vaultUri}/${secretName}/${secretVersion ?? "latest"}`;
      const now = Date.now();
      const cached = secretValueCache.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.value;

      try {
        const path = secretVersion
          ? `/secrets/${encodeURIComponent(secretName)}/${encodeURIComponent(secretVersion)}`
          : `/secrets/${encodeURIComponent(secretName)}`;
        const result = await akvRequest<{ value?: string }>(
          {
            vaultUri: config.vaultUri,
            method: "GET",
            path,
          },
        );
        const value = result.value;
        if (typeof value !== "string") throw new Error("Azure Key Vault returned empty secret value");
        secretValueCache.set(cacheKey, { value, expiresAt: now + AKV_SECRET_CACHE_TTL_MS });
        return value;
      } catch (error) {
        normalizeAkvError("resolveVersion", error);
      }
    },
    async deleteOrArchive(input) {
      if (!input.material) return;
      const material = asAkvMaterial(input.material);
      if (material.source !== "managed") return;

      const config = resolveConfig(input.providerConfig);
      const secretName = input.externalRef?.trim() ?? material.secretName;

      try {
        if (input.mode === "archive") {
          // Disable the secret version rather than delete
          const path = material.secretVersion
            ? `/secrets/${encodeURIComponent(secretName)}/${encodeURIComponent(material.secretVersion)}`
            : `/secrets/${encodeURIComponent(secretName)}`;
          await akvRequest({ vaultUri: config.vaultUri, method: "PUT", path, body: { attributes: { enabled: false } } });
          return;
        }
        await akvRequest({
          vaultUri: config.vaultUri,
          method: "DELETE",
          path: `/secrets/${encodeURIComponent(secretName)}`,
        });
      } catch (error) {
        normalizeAkvError(input.mode === "archive" ? "disableSecret" : "deleteSecret", error);
      }
    },
    healthCheck,
  };
}

export const azureKeyVaultProvider = createAzureKeyVaultProvider();

/** For use in tests only — clears in-process token and secret value caches. */
export function _clearAkvCachesForTest(): void {
  tokenCache.clear();
  secretValueCache.clear();
}
