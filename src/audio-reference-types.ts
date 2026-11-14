import { MediaSettingsError, type MediaVideoModel } from "./model-catalog.js";

/** Decoded bytes of one reference clip: well past 30 seconds of any admitted container. */
export const MAX_AUDIO_REFERENCE_BYTES = 16 * 1024 * 1024;
/** Decoded bytes across every clip of one request; base64 adds a third. */
export const MAX_AUDIO_REFERENCE_BODY_BYTES = 24 * 1024 * 1024;

/** One reference clip with the facts the provider request and the 30-second budget need. */
export type MediaAudioReferenceBytes = Readonly<{
  /** Exact clip bytes as the Computer holds them. */
  bytes: Uint8Array;
  /** Media type of the clip's container, from its parsed header. */
  mimeType: AudioReferenceMimeType;
  /** Whole-clip duration in seconds, from the parsed header or decoded stream. */
  durationSeconds: number;
  /** Optional filename for diagnostics. */
  filename?: string;
}>;

/**
 * Containers a clip may arrive in: `mp3`, `m4a`, `wav`, `ogg` and `opus`
 * files. Seedance 2.5 states only that clips are "base64 data:audio/... URIs"
 * and does not list formats, so Darkroom admits what the gallery plays.
 * https://developers.cloudflare.com/ai/models/bytedance/seedance-2.5/schema-input.json
 */
export type AudioReferenceMimeType =
  "audio/mpeg" | "audio/mp4" | "audio/wav" | "audio/ogg";

/**
 * Enforce the model's declared clip count and total duration. Neither is
 * clamped: a clip over budget refuses the request instead of being dropped.
 */
export function checkAudioReferenceBudget(
  label: string,
  limits: NonNullable<MediaVideoModel["audioReferences"]>,
  clips: readonly Pick<MediaAudioReferenceBytes, "durationSeconds">[],
): void {
  if (clips.length > limits.max)
    throw new MediaSettingsError(
      `${label} takes up to ${String(limits.max)} audio references`,
    );
  const total = clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
  if (total > limits.totalSeconds)
    throw new MediaSettingsError(
      `${label} audio references total ${total.toFixed(1)} seconds; the limit is ${String(limits.totalSeconds)}`,
    );
}
