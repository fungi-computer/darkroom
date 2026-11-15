import { MAX_AUDIO_REFERENCE_BYTES } from "./audio-reference-types.js";
import { MediaSettingsError } from "./model-catalog.js";
import { MAX_REFERENCE_BYTES, type MediaReference } from "./index.js";

/** One stored reference: its size is known before its bytes are loaded. */
export type HostReferenceSource = Readonly<{
  /** Stored byte length, checked before the bytes are read. */
  size: number;
  /** Load the exact stored bytes. */
  bytes: () => Promise<Uint8Array>;
}>;

/**
 * The one owner of a host reference read's refusals. The reference must name
 * the host's admitted destination, exist, be non-empty and fit the byte limit
 * for its kind; anything else is a {@link MediaSettingsError} raised before
 * any provider dispatch.
 */
export async function readHostReference(
  input: Readonly<{
    reference: MediaReference;
    /** The host's admitted destination identity. */
    destinationId: string;
    kind: "image" | "audio";
    /** Open the reference path in the host's store, or null when missing. */
    open: (path: string) => Promise<HostReferenceSource | null>;
  }>,
): Promise<Uint8Array> {
  const { reference, kind } = input;
  if (reference.computerId !== input.destinationId)
    throw new MediaSettingsError("reference Computer is not selected");
  const limit =
    kind === "image" ? MAX_REFERENCE_BYTES : MAX_AUDIO_REFERENCE_BYTES;
  const source = await input.open(reference.path);
  if (source === null || source.size === 0 || source.size > limit)
    throw new MediaSettingsError(
      `${kind} reference is unavailable or exceeds the byte limit`,
    );
  const bytes = await source.bytes();
  if (bytes.byteLength === 0 || bytes.byteLength > limit)
    throw new MediaSettingsError(
      `${kind} reference is unavailable or exceeds the byte limit`,
    );
  return bytes;
}

/** The filename sent with a multipart reference: the last path segment. */
export function referenceFilename(reference: MediaReference): string {
  return reference.path.split("/").at(-1) ?? "reference";
}
