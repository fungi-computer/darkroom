import * as Redacted from "effect/Redacted";

/** Retain the original failure without printing provider or customer data. */
export function reportCatchFailure(operation: string, cause: unknown): void {
  console.error(
    "Media service operation failed",
    {
      operation,
      errorKind: cause instanceof Error ? "error" : "non-error",
    },
    Redacted.make(cause),
  );
}
