import { getMediaModel, MediaSettingsError } from "./model-catalog.js";
import {
  validateMediaGenerationSettings,
  estimateVideoMilliunits,
  type MediaGenerationSettings,
  type MediaReferenceBytes,
} from "./index.js";
import type { MediaVideoModelId } from "./model-catalog.js";
import {
  videoProviderAdapters,
  type CheckedVideoSettings,
} from "./video-providers/index.js";

/** Gateway images and the verified catalog's video families share Unified billing. */
export type GatewayModelId = "openai/gpt-image-2" | MediaVideoModelId;
export const isGatewayModel = (id: string): id is GatewayModelId =>
  id === "openai/gpt-image-2" || getMediaModel(id)?.kind === "video";

/** What one generation bills: whole images, or seconds of video. */
export type MediaUnits = Readonly<{
  /** One image or one whole video second. */
  unit: "image" | "video_second";
  /** Number of delivered or admitted units. */
  units: number;
}>;

/** Billing units for validated settings; video bills its requested length. */
export function mediaUnits(settings: MediaGenerationSettings): MediaUnits {
  const model = getMediaModel(settings.model);
  if (model === undefined)
    throw new MediaSettingsError("billing units require a known Media model");
  if (model.kind === "video") {
    const checked = validateMediaGenerationSettings({
      ...settings,
      references: settings.references?.map((reference) => ({ ...reference })),
    });
    if (checked.durationSeconds === undefined)
      throw new MediaSettingsError("video settings need a duration");
    return { unit: "video_second", units: checked.durationSeconds };
  }
  return { unit: "image", units: 1 };
}

/**
 * GPT Image 2 output tokens per image at `medium` quality. OpenAI publishes
 * this table for its gpt-image models; PRICE DECISION PENDING (Levi): confirm
 * against the first live gateway logs, which carry the real token counts.
 */
const gptImageOutputTokens = new Map([
  ["1024x1024", 1_056],
  ["1024x1536", 1_584],
  ["1536x1024", 1_568],
]);
/** USD per million tokens: text input and image output. */
const gptImageRates = { input: 5, outputImage: 30 } as const;

const sizeOf = (settings: MediaGenerationSettings) =>
  `${String(settings.width)}x${String(settings.height)}`;

/** Milliunits (1 cent = 1,000) of provider cost, rounded up. */
export function estimateGatewayMilliunits(
  settings: MediaGenerationSettings,
): number {
  if (settings.model === "openai/gpt-image-2") {
    const output = gptImageOutputTokens.get(sizeOf(settings));
    if (output === undefined)
      throw new MediaSettingsError("unsupported GPT Image 2 size");
    // A bound on prompt tokens: at most one token per character.
    const input = settings.prompt.length;
    // tokens * USD/M * 100,000 milliunits/USD / 1,000,000 = tokens * rate / 10
    return Math.ceil(
      (output * gptImageRates.outputImage + input * gptImageRates.input) / 10,
    );
  }
  if (getMediaModel(settings.model)?.kind === "video")
    return estimateVideoMilliunits(settings);
  throw new MediaSettingsError(`${settings.model} is not a gateway model`);
}

/** The provider JSON body for one validated gateway generation. */
export function gatewayInput(
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[] = [],
  outputFormat: "png" | "jpeg" | "webp" = "png",
) {
  if (settings.model === "openai/gpt-image-2")
    return {
      prompt: settings.prompt,
      size: sizeOf(settings),
      quality: "medium",
      output_format: outputFormat,
    };
  const checked = validateMediaGenerationSettings({
    ...settings,
    references: settings.references?.map((reference) => ({ ...reference })),
  });
  const model = getMediaModel(checked.model);
  if (
    model?.video == null ||
    checked.resolution === undefined ||
    checked.aspectRatio === undefined ||
    checked.durationSeconds === undefined
  )
    throw new MediaSettingsError("not a video gateway model");
  if (references.length !== (checked.references?.length ?? 0))
    throw new MediaSettingsError(
      "resolved video references must match every admitted reference",
    );
  const videoSettings: CheckedVideoSettings = {
    ...checked,
    resolution: checked.resolution,
    aspectRatio: checked.aspectRatio,
    durationSeconds: checked.durationSeconds,
  };
  return videoProviderAdapters[model.video.provider].buildInput(
    videoSettings,
    references,
    model,
  );
}
