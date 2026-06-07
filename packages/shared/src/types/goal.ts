import type { GoalLevel, GoalStatus } from "../constants.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  ownershipKind?: "agent_driven" | "human_owned";
  progress?: {
    linkedIssueCount: number;
    closedIssueCount: number;
    openIssueCount: number;
    percent: number;
    byStatus: Record<string, number>;
  };
  createdAt: Date;
  updatedAt: Date;
}
