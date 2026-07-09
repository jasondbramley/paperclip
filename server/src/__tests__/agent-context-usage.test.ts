import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildAgentContextUsageEstimate, heartbeatService } from "../services/heartbeat.ts";

const baseAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  name: "Context Agent",
  adapterType: "codex_local",
  adapterConfig: {},
  runtimeConfig: {
    heartbeat: {
      contextMonitor: {
        contextWindowTokens: 1_000,
        warningRatio: 0.8,
        preemptRatio: 0.9,
      },
    },
  },
  capabilities: "x".repeat(400),
};

describe("agent context usage estimates", () => {
  it("classifies warning and preempt bands from estimated token pressure", () => {
    const warning = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 650,
      assignedTicketTextTokens: 50,
      now: new Date("2026-05-24T12:00:00Z"),
    });

    expect(warning.components.capabilitiesTokens).toBe(100);
    expect(warning.estimatedTokens).toBe(800);
    expect(warning.band).toBe("warn");

    const preempt = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 750,
      assignedTicketTextTokens: 50,
      now: new Date("2026-05-25T02:30:00Z"),
    });

    expect(preempt.estimatedTokens).toBe(900);
    expect(preempt.band).toBe("preempt");
    expect(preempt.quietWindow).toBe(true);
  });

  it("keeps normal estimates below the warning threshold", () => {
    const estimate = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 300,
      assignedTicketTextTokens: 50,
      now: new Date("2026-05-24T12:00:00Z"),
    });

    expect(estimate.estimatedTokens).toBe(450);
    expect(estimate.band).toBe("ok");
    expect(estimate.quietWindow).toBe(false);
  });

  it("keeps raw assigned ticket tokens advisory-only", () => {
    const estimate = buildAgentContextUsageEstimate({
      agent: baseAgent,
      recentRunUsageTokens: 300,
      assignedTicketTextTokens: 0,
      rawAssignedTicketTextTokens: 1_000,
      now: new Date("2026-05-24T12:00:00Z"),
    });

    expect(estimate.components.assignedTicketTokens).toBe(0);
    expect(estimate.components.rawAssignedTicketTokens).toBe(1_000);
    expect(estimate.estimatedTokens).toBe(400);
    expect(estimate.band).toBe("ok");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent context usage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent context preempt retire/rebuild", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let previousCreateIssuesGate: string | undefined;

  beforeAll(async () => {
    previousCreateIssuesGate = process.env.AGENT_CONTEXT_MONITOR_CREATE_ISSUES;
    process.env.AGENT_CONTEXT_MONITOR_CREATE_ISSUES = "1";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-context-usage-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    if (previousCreateIssuesGate === undefined) {
      delete process.env.AGENT_CONTEXT_MONITOR_CREATE_ISSUES;
    } else {
      process.env.AGENT_CONTEXT_MONITOR_CREATE_ISSUES = previousCreateIssuesGate;
    }
    await tempDb?.cleanup();
  });

  async function seedPreemptCandidate() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();
    const reporteeId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Manager",
        role: "manager",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Context Agent",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        capabilities: "x".repeat(400),
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-test" },
        runtimeConfig: {
          heartbeat: {
            contextMonitor: {
              contextWindowTokens: 100,
              warningRatio: 0.8,
              preemptRatio: 0.9,
            },
          },
        },
        permissions: { grants: ["issues:update"] },
      },
      {
        id: reporteeId,
        companyId,
        name: "Reportee",
        role: "engineer",
        status: "idle",
        reportsTo: agentId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "PAP-1",
    });

    return { companyId, managerId, agentId, reporteeId, issueId };
  }

  it("creates a preempt issue outside the quiet window without retiring the agent", async () => {
    const seeded = await seedPreemptCandidate();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAgentContextUsage({
      companyId: seeded.companyId,
      now: new Date("2026-05-25T12:00:00Z"),
    });

    expect(result.preemptsCreated).toBe(1);
    const [source] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
    const [activeIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const preemptIssues = await db.select().from(issues).where(eq(issues.originKind, "agent_context_usage_preempt"));
    expect(source?.status).toBe("idle");
    expect(activeIssue?.assigneeAgentId).toBe(seeded.agentId);
    expect(preemptIssues).toHaveLength(1);
    expect(preemptIssues[0]?.status).toBe("todo");
  });

  it("ignores retired paused merged agents with heartbeat disabled", async () => {
    const seeded = await seedPreemptCandidate();
    const retiredAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: replacementAgentId,
        companyId: seeded.companyId,
        name: "Replacement",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: retiredAgentId,
        companyId: seeded.companyId,
        name: "People Operations Officer (retired 2026-06-20 -- merged into CEO / Dispatcher)",
        role: "operations",
        status: "paused",
        reportsTo: seeded.managerId,
        capabilities: "x".repeat(400),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            wakeOnDemand: false,
            contextMonitor: {
              contextWindowTokens: 100,
              warningRatio: 0.8,
              preemptRatio: 0.9,
            },
          },
        },
        permissions: {},
        metadata: {
          retiredAt: "2026-06-20T00:00:00.000Z",
          replacementAgentId,
        },
      },
    ]);
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAgentContextUsage({
      companyId: seeded.companyId,
      now: new Date("2026-05-25T12:00:00Z"),
    });

    const preemptIssues = await db.select().from(issues).where(eq(issues.originKind, "agent_context_usage_preempt"));

    expect(result.preemptsCreated).toBe(1);
    expect(result.estimates.map((estimate) => estimate.agentId)).toContain(seeded.agentId);
    expect(result.estimates.map((estimate) => estimate.agentId)).not.toContain(retiredAgentId);
    expect(preemptIssues).toHaveLength(1);
    expect(preemptIssues[0]?.originId).toBe(seeded.agentId);
  });

  it("does not retire and rebuild during the quiet window while retire/rebuild is force-gated", async () => {
    const seeded = await seedPreemptCandidate();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAgentContextUsage({
      companyId: seeded.companyId,
      now: new Date("2026-05-25T02:30:00Z"),
    });

    expect(result.preemptsCreated).toBe(1);
    const [source] = await db.select().from(agents).where(eq(agents.id, seeded.agentId));
    const [activeIssue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const [reportee] = await db.select().from(agents).where(eq(agents.id, seeded.reporteeId));
    const replacements = await db.select().from(agents).where(eq(agents.name, "Context Agent"));
    const replacement = replacements.find((agent) => agent.id !== seeded.agentId);
    const preemptIssues = await db.select().from(issues).where(eq(issues.originKind, "agent_context_usage_preempt"));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, preemptIssues[0]!.id));
    const auditRows = await db.select().from(activityLog).where(eq(activityLog.action, "agent.retire_rebuild"));

    expect(source?.status).toBe("idle");
    expect(replacement).toBeUndefined();
    expect(activeIssue?.assigneeAgentId).toBe(seeded.agentId);
    expect(reportee?.reportsTo).toBe(seeded.agentId);
    expect(preemptIssues[0]?.status).toBe("todo");
    expect(comments).toHaveLength(0);
    expect(auditRows).toHaveLength(0);

    const secondResult = await heartbeat.scanAgentContextUsage({
      companyId: seeded.companyId,
      now: new Date("2026-05-25T03:00:00Z"),
    });
    const replacementsAfterSecondScan = await db.select().from(agents).where(eq(agents.name, "Context Agent"));
    const preemptIssuesAfterSecondScan = await db.select().from(issues).where(eq(issues.originKind, "agent_context_usage_preempt"));
    const auditRowsAfterSecondScan = await db.select().from(activityLog).where(eq(activityLog.action, "agent.retire_rebuild"));

    expect(secondResult.preemptsCreated).toBe(0);
    expect(replacementsAfterSecondScan).toHaveLength(1);
    expect(preemptIssuesAfterSecondScan).toHaveLength(1);
    expect(auditRowsAfterSecondScan).toHaveLength(0);
  });

  it("does not count inherited assigned ticket text for a freshly rebuilt untouched agent", async () => {
    const companyId = randomUUID();
    const sourceAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    const inheritedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: sourceAgentId,
        companyId,
        name: "Context Agent",
        role: "engineer",
        status: "terminated",
        capabilities: "minimal",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata: {
          replacementAgentId,
          retiredBy: "agent_context_preempt",
          retiredAt: "2026-07-08T02:00:00.000Z",
        },
      },
      {
        id: replacementAgentId,
        companyId,
        name: "Context Agent",
        role: "engineer",
        status: "idle",
        capabilities: "minimal",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            contextMonitor: {
              contextWindowTokens: 1_000,
              warningRatio: 0.8,
              preemptRatio: 0.9,
            },
          },
        },
        permissions: {},
        metadata: {
          rebuiltFromAgentId: sourceAgentId,
          rebuiltAt: "2026-07-08T02:05:00.000Z",
          rebuildReason: "agent_context_preempt",
        },
      },
    ]);
    await db.insert(issues).values({
      id: inheritedIssueId,
      companyId,
      title: "Inherited large assignment",
      description: "x".repeat(4_000),
      status: "todo",
      priority: "medium",
      assigneeAgentId: replacementAgentId,
      issueNumber: 1,
      identifier: "PAP-1",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: inheritedIssueId,
      authorAgentId: sourceAgentId,
      authorType: "agent",
      body: "y".repeat(4_000),
    });

    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAgentContextUsage({
      companyId,
      now: new Date("2026-07-08T02:10:00Z"),
    });

    const replacementEstimate = result.estimates.find((estimate) => estimate.agentId === replacementAgentId);
    expect(replacementEstimate?.components.assignedTicketTokens).toBe(0);
    expect(replacementEstimate?.components.rawAssignedTicketTokens).toBeGreaterThan(1_900);
    expect(replacementEstimate?.estimatedTokens).toBeLessThan(800);
    expect(replacementEstimate?.band).toBe("ok");
    expect(result.preemptsCreated).toBe(0);
  });

  it("counts assigned ticket text for issues the agent has already touched", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const touchedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Context Agent",
      role: "engineer",
      status: "idle",
      capabilities: "minimal",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          contextMonitor: {
            contextWindowTokens: 5_000,
            warningRatio: 0.8,
            preemptRatio: 0.9,
          },
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: touchedIssueId,
      companyId,
      title: "Touched work",
      description: "x".repeat(4_000),
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "PAP-1",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: touchedIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "agent-side planning and follow-up context",
    });

    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanAgentContextUsage({
      companyId,
      now: new Date("2026-07-08T02:20:00Z"),
    });

    const estimate = result.estimates.find((item) => item.agentId === agentId);
    expect(estimate).toBeDefined();
    expect(estimate?.components.rawAssignedTicketTokens).toBe(estimate?.components.assignedTicketTokens);
    expect(estimate?.components.assignedTicketTokens).toBeGreaterThan(0);
    expect(estimate?.band).toBe("ok");
  });
});
