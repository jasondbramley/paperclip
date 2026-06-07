import { describe, expect, it } from "vitest";
import { deriveGoalProgress } from "../services/goals.js";

describe("deriveGoalProgress", () => {
  it("rolls linked issue statuses into closed/open counts and a rounded percent", () => {
    expect(deriveGoalProgress({ done: 2, cancelled: 1, todo: 1, blocked: 2 })).toEqual({
      linkedIssueCount: 6,
      closedIssueCount: 3,
      openIssueCount: 3,
      percent: 50,
      byStatus: { done: 2, cancelled: 1, todo: 1, blocked: 2 },
    });
  });

  it("returns zero progress for goals with no linked issues", () => {
    expect(deriveGoalProgress({})).toEqual({
      linkedIssueCount: 0,
      closedIssueCount: 0,
      openIssueCount: 0,
      percent: 0,
      byStatus: {},
    });
  });
});
