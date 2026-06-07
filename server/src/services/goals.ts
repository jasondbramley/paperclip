import { and, asc, eq, isNull, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issues } from "@paperclipai/db";

type GoalReader = Pick<Db, "select">;
type GoalRow = typeof goals.$inferSelect;

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export type GoalProgress = {
  linkedIssueCount: number;
  closedIssueCount: number;
  openIssueCount: number;
  percent: number;
  byStatus: Record<string, number>;
};

export type GoalWithProgress = GoalRow & {
  ownershipKind: "agent_driven" | "human_owned";
  progress: GoalProgress;
};

export function deriveGoalProgress(statusCounts: Record<string, number>): GoalProgress {
  const linkedIssueCount = Object.values(statusCounts).reduce((total, count) => total + count, 0);
  const closedIssueCount = Object.entries(statusCounts).reduce(
    (total, [status, count]) => total + (CLOSED_ISSUE_STATUSES.has(status) ? count : 0),
    0,
  );
  const openIssueCount = Math.max(0, linkedIssueCount - closedIssueCount);
  const percent = linkedIssueCount === 0 ? 0 : Math.round((closedIssueCount / linkedIssueCount) * 100);
  return { linkedIssueCount, closedIssueCount, openIssueCount, percent, byStatus: statusCounts };
}

function deriveGoalStatus(goal: GoalRow, progress: GoalProgress) {
  if (progress.linkedIssueCount === 0) return goal.status;
  if (progress.openIssueCount === 0) return "done";
  if (goal.status === "planned") return "active";
  return goal.status;
}

function enrichGoalWithProgress(goal: GoalRow, progress: GoalProgress): GoalWithProgress {
  return {
    ...goal,
    status: deriveGoalStatus(goal, progress),
    ownershipKind: goal.ownerAgentId ? "agent_driven" : "human_owned",
    progress,
  };
}

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: async (companyId: string) => {
      const [goalRows, issueCounts] = await Promise.all([
        db.select().from(goals).where(eq(goals.companyId, companyId)),
        db
          .select({
            goalId: issues.goalId,
            status: issues.status,
            count: sql<number>`count(*)::int`,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), not(isNull(issues.goalId)), isNull(issues.hiddenAt)))
          .groupBy(issues.goalId, issues.status),
      ]);

      const countsByGoal = new Map<string, Record<string, number>>();
      for (const row of issueCounts) {
        if (!row.goalId) continue;
        const counts = countsByGoal.get(row.goalId) ?? {};
        counts[row.status] = Number(row.count) || 0;
        countsByGoal.set(row.goalId, counts);
      }

      return goalRows.map((goal) => enrichGoalWithProgress(goal, deriveGoalProgress(countsByGoal.get(goal.id) ?? {})));
    },

    getById: async (id: string) => {
      const goal = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!goal) return null;

      const statusRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.goalId, id), isNull(issues.hiddenAt)))
        .groupBy(issues.status);

      const counts = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count) || 0]));
      return enrichGoalWithProgress(goal, deriveGoalProgress(counts));
    },

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
