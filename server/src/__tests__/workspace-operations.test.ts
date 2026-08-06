import { describe, expect, it, vi } from "vitest";
import {
  isPostgresDeadlockError,
  withDeadlockRetry,
} from "../services/workspace-operations.js";

describe("workspace operation deadlock retry", () => {
  it("recognizes a nested PostgreSQL deadlock error", () => {
    expect(
      isPostgresDeadlockError({
        cause: { cause: { code: "40P01" } },
      }),
    ).toBe(true);
    expect(isPostgresDeadlockError({ code: "23505" })).toBe(false);
  });

  it("retries deadlocks and returns the eventual result", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: "40P01" })
      .mockRejectedValueOnce({ cause: { code: "40P01" } })
      .mockResolvedValue("recorded");

    await expect(withDeadlockRetry(operation)).resolves.toBe("recorded");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-deadlock failures", async () => {
    const error = Object.assign(new Error("connection lost"), { code: "08006" });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(withDeadlockRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
