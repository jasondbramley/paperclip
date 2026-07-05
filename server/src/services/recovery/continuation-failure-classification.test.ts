import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

type AnyRun = Parameters<typeof classifyContinuationFailure>[0];

function run(overrides: Partial<NonNullable<AnyRun>>): AnyRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "failed",
    error: null,
    errorCode: null,
    contextSnapshot: null,
    livenessState: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as AnyRun;
}

describe("classifyContinuationFailure text fallbacks (ITO-2142)", () => {
  it("keeps structured errorCode classification first", () => {
    expect(classifyContinuationFailure(run({ errorCode: "timeout" }))).toMatchObject({
      kind: "transient_infra",
    });
    expect(classifyContinuationFailure(run({ errorCode: "budget_exhausted" }))).toMatchObject({
      kind: "non_retryable",
      maxAttempts: 0,
    });
  });

  it("classifies stream-disconnect error text as transient infra", () => {
    for (const error of [
      "stream disconnected before completion",
      "response.failed event received from provider",
      "transport error: timeout waiting for chunk",
      "upstream returned HTTP 503",
    ]) {
      expect(classifyContinuationFailure(run({ error }))).toMatchObject({
        kind: "transient_infra",
        maxAttempts: 3,
      });
    }
  });

  it("gives context-window overflows exactly one retry", () => {
    for (const error of [
      "prompt exceeds context window",
      "maximum context length exceeded",
    ]) {
      expect(classifyContinuationFailure(run({ error }))).toMatchObject({
        kind: "transient_infra",
        maxAttempts: 1,
      });
    }
  });

  it("leaves unrecognised failures on the default single-attempt path", () => {
    expect(classifyContinuationFailure(run({ error: "segfault in adapter" }))).toMatchObject({
      kind: "default",
      maxAttempts: 1,
    });
  });
});
