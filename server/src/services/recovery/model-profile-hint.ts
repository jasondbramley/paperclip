export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

export type RecoveryModelProfileWorkClass = "status_only" | "normal_model";

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

const RECOVERY_MODEL_PROFILE_HINT_KEYS = [
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
] as const;

type RecoveryModelProfileHintKey = (typeof RECOVERY_MODEL_PROFILE_HINT_KEYS)[number];
type WithoutRecoveryModelProfileHints<T> = Omit<T, RecoveryModelProfileHintKey>;

export function scrubRecoveryModelProfileHints<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryModelProfileHints<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_MODEL_PROFILE_HINT_KEYS) {
    delete output[key];
  }
  return output as WithoutRecoveryModelProfileHints<T>;
}

// Overload: no workClass → legacy "cheap" model profile hint (backward compat)
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
): T & { modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY };
// Overload: normal_model → scrub all hints (run with full capabilities)
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryModelProfileHints<T>;
// Overload: status_only → add cheap model + guard context (no deliverable work)
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
  modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
};
// Implementation
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass?: RecoveryModelProfileWorkClass,
):
  | (T & { modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY })
  | WithoutRecoveryModelProfileHints<T>
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  }) {
  if (workClass === "normal_model") {
    return scrubRecoveryModelProfileHints(input);
  }

  if (workClass === "status_only") {
    return {
      ...scrubRecoveryModelProfileHints(input),
      ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
      modelProfile: RECOVERY_MODEL_PROFILE_KEY,
    };
  }

  // Legacy: no workClass — add cheap model profile hint only
  return {
    ...input,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

export function recoveryAssigneeAdapterOverrides(
  _workClass?: Extract<RecoveryModelProfileWorkClass, "status_only">,
) {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}
