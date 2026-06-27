import { describe, expect, it } from "vitest";
import { isDeliberateLongLivedChatMirror } from "../services/productivity-review.ts";

describe("productivity review chat mirror classification", () => {
  it("recognises explicit long-lived Teams chat mirrors", () => {
    expect(isDeliberateLongLivedChatMirror({
      title: "CEO — Ross — chat mirror (post-rebuild conversation ticket)",
      description: "Long-lived conversation ticket for the CEO — Ross Teams chat. Used by chat-bridge daemon to mirror messages. DO NOT CLOSE.",
    })).toBe(true);
  });

  it("does not classify ordinary long-running delivery issues as chat mirrors", () => {
    expect(isDeliberateLongLivedChatMirror({
      title: "Implement data import",
      description: "Delivery ticket that has been in progress for a long time and should still be reviewed.",
    })).toBe(false);
  });

  it("does not classify generic Teams conversation work without a chat-mirror marker", () => {
    expect(isDeliberateLongLivedChatMirror({
      title: "Build Teams conversation ticket handoff",
      description: "Delivery work for a Teams chat conversation ticket that should still be reviewed if it runs too long.",
    })).toBe(false);
  });
});
