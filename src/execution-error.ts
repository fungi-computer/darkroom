import * as z from "zod";
import {
  decodeMediaProviderDiagnostic,
  type MediaProviderDiagnostic,
} from "@fungi.computer/agar/errors";

/** Public diagnostic labels only; never provider messages or request data. */
export const mediaFailureStageSchema = z.enum({
  /** Host admission before operation creation. */
  admission: "admission",
  /** Host authority check before dispatch. */
  "generation-authorization": "generation-authorization",
  /** Generation settings validation. */
  settings: "settings",
  /** Reference preparation and cost estimation. */
  estimate: "estimate",
  /** Host price admission or settlement. */
  billing: "billing",
  /** Durable operation transition. */
  operation: "operation",
  /** Provider dispatch. */
  provider: "provider",
  /** Provider output decoding. */
  normalization: "normalization",
  /** Retained output storage. */
  artifact: "artifact",
  /** Host permission check before saving. */
  "destination-authorization": "destination-authorization",
  /** Host destination write. */
  "destination-write": "destination-write",
});

/** Execution stage at which a generation failed. */
export type MediaFailureStage = Exclude<
  z.output<typeof mediaFailureStageSchema>,
  "admission" | "settings"
>;

/** Private cause plus an independently decoded, safe provider diagnostic. */
export type MediaExecutionErrorOptions = ErrorOptions & {
  /** Safe provider facts, when the failure came from provider transport. */
  readonly provider?: MediaProviderDiagnostic | undefined;
  /** Confirmed zero-unit customer settlement, never an upstream billing claim. */
  readonly customerCharge?: "none" | undefined;
};

/** A bounded stage marker for failures that cross the Media HTTP boundary. */
export class MediaExecutionError extends Error {
  /** Safe provider facts only; the original cause remains private. */
  readonly provider: MediaProviderDiagnostic | undefined;
  /** Unknown unless the execution owner confirmed zero-unit settlement. */
  readonly customerCharge: "none" | "unknown";

  constructor(
    /** Execution stage where the failure occurred. */
    readonly stage: MediaFailureStage,
    options?: MediaExecutionErrorOptions,
  ) {
    super(`Media ${stage} failed`, options);
    this.name = "MediaExecutionError";
    this.customerCharge = options?.customerCharge ?? "unknown";
    this.provider =
      options?.provider === undefined
        ? undefined
        : decodeMediaProviderDiagnostic(options.provider);
  }
}

/** A provider safety filter refused generation; no output was delivered. */
export class MediaSafetyFilterRefusal extends MediaExecutionError {
  constructor(options?: MediaExecutionErrorOptions) {
    super("provider", options);
    this.name = "MediaSafetyFilterRefusal";
  }
}

/** Why the host's billing owner refused to admit a new generation. */
export type MediaBillingRefusalCode =
  "insufficient_credits" | "daily_limit_reached" | "denied";

/** A definitive billing refusal before dispatch; nothing was generated or charged. */
export class MediaBillingRefusal extends Error {
  constructor(
    /** Bounded refusal or failure reason. */
    readonly code: MediaBillingRefusalCode,
  ) {
    super(`Media billing refused: ${code}`);
    this.name = "MediaBillingRefusal";
  }
}

/** The durable format pin prevents a mismatched file extension or retained output. */
export class MediaOutputFormatMismatch extends Error {
  constructor() {
    super("Media provider did not return the requested image format");
    this.name = "MediaOutputFormatMismatch";
  }
}
