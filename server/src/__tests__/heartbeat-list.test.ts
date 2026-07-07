import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boundHeartbeatRunEventPayloadForStorage, heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("summarizes small result json payloads from getRun without raw output bodies", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        stdout: "synthetic-sensitive-stdout-marker",
        stderr: "synthetic-sensitive-stderr-marker",
        structured: { ok: true },
      },
      stdoutExcerpt: "synthetic-sensitive-stdout-excerpt",
      stderrExcerpt: "synthetic-sensitive-stderr-excerpt",
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
    });
    expect(run?.stdoutExcerpt).toBeNull();
    expect(run?.stderrExcerpt).toBeNull();
    expect(JSON.stringify(run)).not.toContain("synthetic-sensitive");
  });

  it("redacts output bodies from oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
    });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(result).not.toHaveProperty("truncated");
    expect(JSON.stringify(run)).not.toContain(oversizedStdout.slice(0, 120));
    expect(result).not.toHaveProperty("nestedHuge");
  });

  it("quarantines security-redacted run detail, log, excerpts, and continuation context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      logStore: "local_file",
      logRef: "runs/security-redacted.ndjson",
      logBytes: 1234,
      logSha256: "safe-log-sha",
      stdoutExcerpt: "synthetic-sensitive-stdout-excerpt",
      stderrExcerpt: "synthetic-sensitive-stderr-excerpt",
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
        continuationSummary: "synthetic-sensitive-continuation-summary",
      },
      resultJson: {
        securityRedacted: true,
        redactionReason: "credential_exposure",
        incidentTicket: "ITO-182",
        summary: "synthetic-sensitive-summary",
        stdout: "synthetic-sensitive-stdout-body",
        stderr: "synthetic-sensitive-stderr-body",
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.getRun(runId);
    const log = await heartbeat.readLog(runId);
    const serialized = JSON.stringify({ run, log });

    expect(run?.resultJson).toMatchObject({
      securityRedacted: true,
      redactionReason: "credential_exposure",
      incidentTicket: "ITO-182",
      bodyRedacted: true,
      stdoutRedacted: true,
      stderrRedacted: true,
    });
    expect(run?.stdoutExcerpt).toBeNull();
    expect(run?.stderrExcerpt).toBeNull();
    expect(run?.contextSnapshot).toMatchObject({ wakeReason: "issue_assigned" });
    expect(run?.contextSnapshot).not.toHaveProperty("continuationSummary");
    expect(log).toMatchObject({
      runId,
      redacted: true,
      logBytes: 1234,
      logSha256: "safe-log-sha",
    });
    expect(serialized).not.toContain("synthetic-sensitive");
  });
});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
