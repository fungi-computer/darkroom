import * as z from "zod";
import { mediaFailureStageSchema } from "./execution-error.js";
import { Option, Schema } from "effect";
import { reportCatchFailure } from "./failure.js";
import { mediaProviderDiagnosticWireSchema } from "@fungi.computer/agar/errors";

/** Host diagnostic sink; generation errors and retry truth remain transport-owned. */
export type MediaGenerationDiagnostic = (
  operation:
    "app_media_pending_response_unavailable" | "media_failure_body_read_failed",
  cause: unknown,
  details?: Readonly<{
    /** HTTP response status when the diagnostic concerns a response. */
    status: number;
  }>,
) => void;

/** Sanitized HTTP refusal emitted by a Media host and decoded at the browser boundary. */
export const mediaFailureSchema = z.strictObject({
  /** Host-supplied presentation copy. */
  error: z.string().min(1).max(512),
  /** The failed generation or save stage. */
  stage: mediaFailureStageSchema,
  /** Typed refusal reason; the host retains retry truth. */
  code: z.enum({
    /** Host admission or Computer access was denied. */
    CAPABILITY_DENIED: "CAPABILITY_DENIED",
    /** Host billing did not admit this attempt. */
    INSUFFICIENT_CREDIT: "INSUFFICIENT_CREDIT",
    /** The host could not complete generation or saving. */
    HOST_FAILURE: "HOST_FAILURE",
    /** The host refused the selected input. */
    INVALID_ARGUMENT: "INVALID_ARGUMENT",
    /** The inference provider did not complete generation. */
    MEDIA_PROVIDER_FAILURE: "MEDIA_PROVIDER_FAILURE",
    /** The host confirmed zero-unit customer settlement after provider failure. */
    MEDIA_PROVIDER_FAILURE_UNCHARGED: "MEDIA_PROVIDER_FAILURE_UNCHARGED",
    /** The model's safety filter refused generation. */
    SAFETY_FILTER_REFUSED: "SAFETY_FILTER_REFUSED",
  }),
  /** Whether repeating this exact attempt may recover. */
  retryable: z.boolean(),
  /** Allowlisted provider facts only; the original cause never crosses HTTP. */
  provider: mediaProviderDiagnosticWireSchema.optional(),
});

/** Sanitized Media failure carried from the authenticated host to Agar. */
export type MediaFailure = z.output<typeof mediaFailureSchema>;

function parseMediaFailureJson(json: string): MediaFailure | null {
  // Schema-only App consumers must not retain the browser's JSON decoder.
  const decodeJson = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Json),
  );
  const parsed = mediaFailureSchema.safeParse(
    Option.getOrUndefined(decodeJson(json)),
  );
  return parsed.success ? parsed.data : null;
}

/** Read and decode one Media host failure at the browser HTTP boundary. */
export async function readMediaFailure(
  response: Response,
  diagnostic: MediaGenerationDiagnostic = reportCatchFailure,
): Promise<MediaFailure | null> {
  const json = await response.text().catch((cause: unknown) => {
    diagnostic("media_failure_body_read_failed", cause);
    return null;
  });
  return json === null ? null : parseMediaFailureJson(json);
}
