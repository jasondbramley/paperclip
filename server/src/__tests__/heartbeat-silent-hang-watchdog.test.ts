import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS, heartbeatService } from "../services/heartbeat.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "done",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres silent-hang watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("adapter silent-hang watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-silent-hang-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedHangFixture(opts: {
    now: Date;
    ageMs: number;
    adapterType?: string;
    retryCount?: number;
    withMeaningfulEvent?: boolean;
    sessionId?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Hang Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: opts.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Feature implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    const contextSnapshot: Record<string, unknown> = { issueId };
    if (typeof opts.retryCount === "number") {
      contextSnapshot.retry_count = opts.retryCount;
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      contextSnapshot,
      sessionIdBefore: opts.sessionId ?? null,
      sessionIdAfter: opts.sessionId ?? null,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    // Always add the adapter.invoke event (lifecycle-only = silent hang)
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invoked",
    });

    if (opts.withMeaningfulEvent) {
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId,
        agentId,
        seq: 2,
        eventType: "tool_call",
        stream: "stdout",
        level: "info",
        message: "bash tool called",
      });
    }

    return { companyId, agentId, issueId, runId };
  }

  it("detects silent hang and schedules a retry", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const { companyId, agentId, issueId, runId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAdapterSilentHangs({ now, companyId });

    expect(result.hangDetected).toBe(1);
    expect(result.retryScheduled).toBe(1);
    expect(result.runIds).toContain(runId);

    const [cancelledRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId)));
    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelledRun?.errorCode).toBe("adapter_silent_hang");

    const retryRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["scheduled_retry", "queued"])));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]?.scheduledRetryReason).toBe("silent_hang_retry");
    expect(retryRuns[0]?.retryOfRunId).toBe(runId);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.executionRunId).toBe(retryRuns[0]?.id);
  });

  it("preserves session ID in retry context", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const sessionId = `session-${randomUUID()}`;
    const { companyId, runId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
      sessionId,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.scanAdapterSilentHangs({ now, companyId });

    const retryRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.scheduledRetryReason, "silent_hang_retry")));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]?.sessionIdBefore).toBe(sessionId);
    const ctx = retryRuns[0]?.contextSnapshot as Record<string, unknown> | null;
    expect(ctx?.sessionId).toBe(sessionId);
    expect(ctx?.silent_hang_resume_notice).toBeTruthy();
    expect(ctx?.retryOfRunId).toBe(runId);
  });

  it("skips runs with meaningful tool events", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const { companyId, runId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
      withMeaningfulEvent: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAdapterSilentHangs({ now, companyId });

    expect(result.hangDetected).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("skips runs that have not been running long enough", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const { companyId, runId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS - 30_000, // just under threshold
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAdapterSilentHangs({ now, companyId });

    expect(result.hangDetected).toBe(0);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("skips runs on non-local adapters", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const { companyId, runId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
      adapterType: "webhook",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAdapterSilentHangs({ now, companyId });

    expect(result.hangDetected).toBe(0);
    expect(result.skipped).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("blocks issue when retry limit is exhausted", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const { companyId, issueId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
      retryCount: 2, // at ADAPTER_SILENT_HANG_RETRY_LIMIT
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAdapterSilentHangs({ now, companyId });

    expect(result.hangDetected).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.retryScheduled).toBe(0);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => (c.body ?? "").includes("retry limit"))).toBe(true);
    // Untagged — must NOT have Blocker: prefix
    expect(comments.every((c) => !(c.body ?? "").startsWith("Blocker:"))).toBe(true);
  });

  it("posts tagged Blocker comment on cross-heartbeat escalation", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const windowStartedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const { companyId, agentId, issueId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: null,
      lastError: null,
      stateJson: {
        autoRecovery: {
          streamDisconnect: { windowStartedAt, attempts: 9 },
        },
      },
      updatedAt: now,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanAdapterSilentHangs({ now, companyId });

    expect(result.hangDetected).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.retryScheduled).toBe(0);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => (c.body ?? "").startsWith("Blocker:"))).toBe(true);
    expect(comments.some((c) => (c.body ?? "").includes("Jason Bramley"))).toBe(true);
  });

  it("updates cross-heartbeat guard count in agentRuntimeState", async () => {
    const now = new Date("2026-05-31T18:00:00.000Z");
    const { companyId, agentId } = await seedHangFixture({
      now,
      ageMs: DEFAULT_ADAPTER_SILENT_HANG_TIMEOUT_MS + 30_000,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.scanAdapterSilentHangs({ now, companyId });

    const [state] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    const stateJson = state?.stateJson as Record<string, unknown> | null;
    const autoRecovery = stateJson?.autoRecovery as Record<string, unknown> | undefined;
    const sdState = autoRecovery?.streamDisconnect as Record<string, unknown> | undefined;
    expect(sdState?.attempts).toBeGreaterThanOrEqual(1);
  });
});
