import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchBlockerHandoffSignal } from "../services/issues.js";

const TEST_IDS = vi.hoisted(() => ({
  blockedIssueId: "11111111-1111-4111-8111-111111111111",
  wakeCommentId: "22222222-2222-4222-8222-222222222222",
}));

const mockSuggestions = vi.hoisted(() => [
  {
    issue: {
      id: TEST_IDS.blockedIssueId,
      identifier: "ITO-1858",
      title: "Inside Agent client sweep",
      status: "blocked",
      priority: "medium",
      updatedAt: new Date("2026-06-02T09:00:00Z"),
    },
    assignee: {
      agentId: "agent-tam",
      agentName: "TAM Agent",
      userId: null,
    },
    blockedBy: [],
    confidence: "high" as const,
    score: 1,
    matchedSignalPhrases: ["inside agent reports", "sharepoint", "uploaded"],
    relaySuggestion:
      "Likely unblocks ITO-1858 (TAM Agent (agent-tam)); relay this update to the blocked ticket and wake the assignee if the match is valid.",
  },
]);

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdClearingTerminalExecution: vi.fn(),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(async () => ({
    totalComments: 1,
    latestCommentId: TEST_IDS.wakeCommentId,
    latestCommentAt: new Date("2026-06-02T09:52:40Z"),
  })),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listAttachments: vi.fn(async () => []),
  listBlockerAttention: vi.fn(async () => new Map()),
  listBlockerHandoffSuggestions: vi.fn(async () => mockSuggestions),
  listProductivityReviews: vi.fn(async () => new Map()),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  documentAnnotationService: () => ({}),
  clampIssueListLimit: () => ({}),
  companySearchService: () => ({}),
  issueThreadInteractionService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    decide: vi.fn(async () => ({ allowed: true })),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentService: () => ({
    getIssueDocumentByKey: vi.fn(async () => null),
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    reportRunActivity: vi.fn(async () => undefined),
    wakeup: vi.fn(async () => undefined),
  }),
  ISSUE_LIST_DEFAULT_LIMIT: 500,
  ISSUE_LIST_MAX_LIMIT: 1000,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: vi.fn(async () => undefined),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("blocker handoff index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chatAnchorIssue = {
      id: "chat-anchor",
      companyId: "company-1",
      identifier: "ITO-541",
      title: "HoOps chat anchor",
      description: null,
      status: "in_progress",
      workMode: "standard",
      priority: "medium",
      parentId: null,
      projectId: null,
      goalId: null,
      assigneeAgentId: "agent-hoo",
      assigneeUserId: null,
      originKind: "manual",
      originId: null,
      updatedAt: new Date("2026-06-02T09:55:00Z"),
    };
    mockIssueService.getById.mockResolvedValue(chatAnchorIssue);
    mockIssueService.getByIdClearingTerminalExecution.mockResolvedValue(chatAnchorIssue);
    mockIssueService.getComment.mockResolvedValue({
      id: TEST_IDS.wakeCommentId,
      issueId: "chat-anchor",
      companyId: "company-1",
      body: "I have uploaded the inside agent reports into SharePoint for the top 11 clients.",
    });
  });

  it("scores the Inside Agent SharePoint upload signal as high confidence", () => {
    const match = matchBlockerHandoffSignal({
      message: "I have uploaded the inside agent reports into SharePoint for the top 11 clients.",
      issueText:
        "Blocked until Inside Agent reports are uploaded into SharePoint for the top client cohort.",
    });

    expect(match?.confidence).toBe("high");
    expect(match?.matchedSignalPhrases).toContain("inside agent reports");
  });

  it("exposes a company-scoped search endpoint", async () => {
    const res = await request(await createApp())
      .get("/api/companies/company-1/blocker-handoff-index/search")
      .query({ q: "Inside Agent reports SharePoint", limit: "3" });

    expect(res.status).toBe(200);
    expect(mockIssueService.listBlockerHandoffSuggestions).toHaveBeenCalledWith(
      "company-1",
      "Inside Agent reports SharePoint",
      { limit: 3 },
    );
    expect(res.body.suggestions[0].issue.identifier).toBe("ITO-1858");
  });

  it("adds suggestions to heartbeat context when a wake comment is present", async () => {
    const res = await request(await createApp())
      .get("/api/issues/chat-anchor/heartbeat-context")
      .query({ wakeCommentId: TEST_IDS.wakeCommentId });

    expect(res.status).toBe(200);
    expect(mockIssueService.listBlockerHandoffSuggestions).toHaveBeenCalledWith(
      "company-1",
      "I have uploaded the inside agent reports into SharePoint for the top 11 clients.",
      { limit: 5 },
    );
    expect(res.body.blockerHandoffSuggestions[0].confidence).toBe("high");
  });

  it("logs blocker handoff suggestion declines", async () => {
    mockIssueService.getById
      .mockReset()
      .mockImplementation(async (id: string) => {
        if (id === "chat-anchor") {
          return {
            id: "chat-anchor",
            companyId: "company-1",
            identifier: "ITO-541",
            title: "HoOps chat anchor",
            description: null,
            status: "in_progress",
            workMode: "standard",
            priority: "medium",
            parentId: null,
            projectId: null,
            goalId: null,
            assigneeAgentId: "agent-hoo",
            assigneeUserId: null,
            originKind: "manual",
            originId: null,
            updatedAt: new Date("2026-06-02T09:55:00Z"),
          };
        }
        if (id === TEST_IDS.blockedIssueId) {
          return {
            id: TEST_IDS.blockedIssueId,
            companyId: "company-1",
            identifier: "ITO-1858",
            title: "Inside Agent client sweep",
            description: null,
            status: "blocked",
            workMode: "standard",
            priority: "high",
            parentId: null,
            projectId: null,
            goalId: null,
            assigneeAgentId: "agent-tam",
            assigneeUserId: null,
            originKind: "manual",
            originId: null,
            updatedAt: new Date("2026-06-02T09:00:00Z"),
          };
        }
        return null;
      });

    const app = await createApp();
    const res = await request(app)
      .post("/api/issues/chat-anchor/blocker-handoff-suggestions/decline")
      .send({
        matchedIssueId: TEST_IDS.blockedIssueId,
        wakeCommentId: TEST_IDS.wakeCommentId,
        reason: "Already relayed manually",
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "blocker_handoff_suggestion_declined",
      entityType: "issue",
      entityId: "chat-anchor",
      details: expect.objectContaining({
        matchedIssueId: TEST_IDS.blockedIssueId,
        wakeCommentId: TEST_IDS.wakeCommentId,
      }),
    }));
  });
});
