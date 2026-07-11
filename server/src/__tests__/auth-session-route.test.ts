import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { instanceUserRoles } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

function createJwtDb(runStatus: string | null) {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() =>
        createSelectChain([{
          id: "agent-1",
          companyId: "company-1",
          status: "active",
        }]),
      )
      .mockImplementationOnce(() =>
        createSelectChain(runStatus ? [{ id: "run-1", status: runStatus }] : []),
      ),
  } as any;
}

function addJsonErrorHandler(app: express.Express) {
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
    },
  );
}

describe("actorMiddleware authenticated session profile", () => {
  const originalCloudTenantToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalJwtTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;

  afterEach(() => {
    if (originalCloudTenantToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = originalCloudTenantToken;
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
    if (originalJwtTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalJwtTtl;
    vi.useRealTimers();
  });

  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });

  it("rejects invalid bearer tokens instead of falling back to local trusted board access", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "local_trusted",
      }),
    );
    app.patch("/api/issues/:id", (req, res) => {
      res.json(req.actor);
    });
    addJsonErrorHandler(app);

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .set("Authorization", "Bearer definitely-not-valid")
      .send({ status: "done" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid bearer token" });
  });

  it("keeps local trusted implicit board access when no bearer token is sent", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "local_trusted",
      }),
    );
    app.patch("/api/issues/:id", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).patch("/api/issues/issue-1").send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("accepts local agent JWTs only while the originating run is active", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    const app = express();
    app.use(
      actorMiddleware(createJwtDb("running"), {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });
    addJsonErrorHandler(app);

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_jwt",
    });
  });

  it("rejects local agent JWTs after the originating run has stopped", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    const app = express();
    app.use(
      actorMiddleware(createJwtDb("cancelled"), {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });
    addJsonErrorHandler(app);

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "run-1");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid bearer token" });
  });

  it("rejects local agent JWTs when the request run header does not match the signed run", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    const app = express();
    app.use(
      actorMiddleware(createJwtDb("running"), {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });
    addJsonErrorHandler(app);

    const res = await request(app)
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "different-run");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid bearer token" });
  });

  it("trusts Cloud tenant identity headers and seeds board access", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const inserts: Array<{ values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn(() => {
        const chain = {
          values(values: Record<string, unknown>) {
            inserts.push({ values });
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          onConflictDoNothing() {
            return chain;
          },
          returning() {
            return Promise.resolve([{
              companyId: inserts.at(-1)?.values.companyId,
              membershipRole: inserts.at(-1)?.values.membershipRole,
              status: inserts.at(-1)?.values.status,
            }]);
          },
        };
        return chain;
      }),
      delete: vi.fn(() => ({ where: () => Promise.resolve(undefined) })),
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-user-name", "Stack Owner")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-id", "paperclip-stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "global-user-1",
      userName: "Stack Owner",
      userEmail: "owner@example.com",
      source: "cloud_tenant",
      isInstanceAdmin: false,
      memberships: [expect.objectContaining({ membershipRole: "owner", status: "active" })],
    });
    expect(res.body.companyIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    // authUsers, companies, companyMemberships, and the role-default
    // principalPermissionGrants seeded in place of instance-admin elevation.
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.values).toMatchObject({
      id: "global-user-1",
      email: "owner@example.com",
      emailVerified: true,
    });
  });

  it("purges a stale instance_admin row so the session path stops elevating the cloud-tenant user", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    // Simulates a deployment that previously ran the pre-hardening cloud_tenant
    // path: instance_user_roles still holds an instance_admin row for the
    // tenant user, who can also resolve a BetterAuth session for the same id.
    const state = { staleInstanceAdminRow: true };
    const insertChain = {
      values() {
        return insertChain;
      },
      onConflictDoUpdate() {
        return insertChain;
      },
      onConflictDoNothing() {
        return insertChain;
      },
      returning() {
        return Promise.resolve([{ companyId: "company-1", membershipRole: "owner", status: "active" }]);
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === instanceUserRoles && state.staleInstanceAdminRow ? [{ id: "stale-role-row" }] : [],
            ),
        }),
      })),
      insert: vi.fn(() => insertChain),
      delete: vi.fn((table: unknown) => ({
        where: () => {
          if (table === instanceUserRoles) state.staleInstanceAdminRow = false;
          return Promise.resolve(undefined);
        },
      })),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "global-user-1" },
          user: { id: "global-user-1", name: "Stack Owner", email: "owner@example.com" },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    // Control: while the stale row exists, the session path still elevates.
    const before = await request(app).get("/actor");
    expect(before.body).toMatchObject({ source: "session", isInstanceAdmin: true });

    // One trusted-header authentication purges the stale grant.
    const cloud = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");
    expect(cloud.body).toMatchObject({ source: "cloud_tenant", isInstanceAdmin: false });
    expect(state.staleInstanceAdminRow).toBe(false);

    // The same user no longer gets instance admin via the session path.
    const after = await request(app).get("/actor");
    expect(after.body).toMatchObject({
      source: "session",
      userId: "global-user-1",
      isInstanceAdmin: false,
    });
  });
});
