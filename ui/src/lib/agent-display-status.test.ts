import { describe, expect, it } from "vitest";

import { agentDisplayStatus } from "./agent-display-status";

describe("agentDisplayStatus", () => {
  const fixedNow = Date.parse("2026-06-11T14:00:00.000Z");

  it("uses the external run state when a paused agent has fresh external telemetry", () => {
    expect(
      agentDisplayStatus(
        {
          status: "paused",
          externalRunState: "idle",
          externalSeenAt: new Date(fixedNow - 60_000),
        },
        fixedNow,
      ),
    ).toBe("idle");
    expect(
      agentDisplayStatus(
        {
          status: "paused",
          externalRunState: "running",
          externalSeenAt: new Date(fixedNow - 60_000).toISOString(),
        },
        fixedNow,
      ),
    ).toBe("running");
  });

  it("falls back to persisted status when external telemetry is stale", () => {
    expect(
      agentDisplayStatus(
        {
          status: "paused",
          externalRunState: "running",
          externalSeenAt: new Date(fixedNow - 120_000),
        },
        fixedNow,
      ),
    ).toBe("paused");
  });

  it("ignores external telemetry for non-paused statuses", () => {
    expect(
      agentDisplayStatus(
        {
          status: "running",
          externalRunState: "running",
          externalSeenAt: new Date(fixedNow - 1_000),
        },
        fixedNow,
      ),
    ).toBe("running");
    expect(
      agentDisplayStatus(
        {
          status: "active",
          externalRunState: "idle",
          externalSeenAt: new Date(fixedNow - 1_000),
        },
        fixedNow,
      ),
    ).toBe("active");
  });
});
