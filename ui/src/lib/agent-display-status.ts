import type { Agent, AgentStatus } from "@paperclipai/shared";

const EXTERNAL_STATE_FRESH_MS = 90_000;

type AgentDisplayStatusInput = Pick<Agent, "status" | "externalRunState"> & {
  externalSeenAt?: Date | string | null;
};

function timestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function agentDisplayStatus(agent: AgentDisplayStatusInput, now = Date.now()): AgentStatus {
  if (agent.status !== "paused") return agent.status;
  if (agent.externalRunState !== "idle" && agent.externalRunState !== "running") return agent.status;

  const seenAt = timestampMs(agent.externalSeenAt);
  if (seenAt === null) return agent.status;
  if (now - seenAt > EXTERNAL_STATE_FRESH_MS) return agent.status;

  return agent.externalRunState;
}
