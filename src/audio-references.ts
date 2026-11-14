import { parseBuffer } from "music-metadata";
import {
  getMediaModel,
  MediaSettingsError,
  mediaModels,
  type MediaCatalogue,
} from "./model-catalog.js";
import type { MediaGenerationSettings, MediaReference } from "./index.js";
import {
  MAX_AUDIO_REFERENCE_BODY_BYTES,
  MAX_AUDIO_REFERENCE_BYTES,
  checkAudioReferenceBudget,
  type AudioReferenceMimeType,
  type MediaAudioReferenceBytes,
} from "./audio-reference-types.js";

/** music-metadata's container names, matched case-insensitively. */
function mimeTypeOf(container: string | undefined): AudioReferenceMimeType {
  const name = (container ?? "").toLowerCase();
  if (name === "mpeg") return "audio/mpeg";
  if (name === "wave") return "audio/wav";
  if (name === "ogg") return "audio/ogg";
  if (name === "m4a" || name === "mp4" || name.startsWith("iso"))
    return "audio/mp4";
  throw new MediaSettingsError(
    "audio reference is not an mp3, m4a, wav, ogg or opus file",
  );
}

/**
 * Read one clip's duration and container with music-metadata, the maintained
 * parser. `duration: true` makes it scan a stream whose header has no length.
 */
async function readAudioReference(
  bytes: Uint8Array,
  filename?: string,
): Promise<MediaAudioReferenceBytes> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_REFERENCE_BYTES)
    throw new MediaSettingsError(
      "audio reference is unavailable or exceeds the byte limit",
    );
  let metadata: Awaited<ReturnType<typeof parseBuffer>>;
  try {
    metadata = await parseBuffer(bytes, undefined, { duration: true });
  } catch (cause) {
    throw new MediaSettingsError("audio reference could not be read as audio", {
      cause,
    });
  }
  const durationSeconds = metadata.format.duration;
  if (
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  )
    throw new MediaSettingsError("audio reference has no readable duration");
  const clip = {
    bytes,
    mimeType: mimeTypeOf(metadata.format.container),
    durationSeconds,
  };
  return Object.freeze(filename === undefined ? clip : { ...clip, filename });
}

/** Host-authorized reader for the raw bytes of reference audio clips. */
export type MediaAudioReferenceReader = Readonly<{
  /** Authorize and read one clip; Darkroom parses it, the host never does. */
  read: (reference: MediaReference) => Promise<Uint8Array>;
}>;

/**
 * Read every reference clip through the caller's reader and parse each with
 * music-metadata. The model's declared clip count and total duration are
 * enforced here, before billing admission; nothing is clamped or dropped.
 */
export const resolveMediaAudioReferences = async (
  settings: MediaGenerationSettings,
  reader: MediaAudioReferenceReader,
  catalogue: MediaCatalogue = mediaModels,
): Promise<readonly MediaAudioReferenceBytes[]> => {
  const references = settings.audioReferences ?? [];
  if (references.length === 0) return Object.freeze([]);
  const model = getMediaModel(settings.model, catalogue);
  const limits = model?.video?.audioReferences ?? null;
  if (model === undefined || limits === null)
    throw new MediaSettingsError(
      `${model?.label ?? settings.model} does not take audio references`,
    );
  const resolved: MediaAudioReferenceBytes[] = [];
  let totalBytes = 0;
  for (const reference of references) {
    const bytes = await reader.read(reference);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_AUDIO_REFERENCE_BODY_BYTES)
      throw new MediaSettingsError(
        "audio references exceed the total request size limit",
      );
    resolved.push(
      await readAudioReference(
        bytes,
        reference.path.split("/").at(-1) ?? "reference",
      ),
    );
  }
  checkAudioReferenceBudget(model.label, limits, resolved);
  return Object.freeze(resolved);
};
