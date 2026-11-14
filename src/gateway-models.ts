import {
  getGatewayModel,
  getMediaModel,
  mediaModels,
  MediaSettingsError,
  type MediaCatalogue,
} from "./model-catalog.js";
import {
  validateMediaGenerationSettings,
  estimateVideoMilliunits,
  type MediaGenerationSettings,
  type MediaReferenceBytes,
} from "./index.js";
import type { MediaVideoModelId } from "./model-catalog.js";
import { imageDataUri } from "./video-providers/reference-encoding.js";
import {
  videoProviderAdapters,
  type CheckedVideoSettings,
} from "./video-providers/index.js";

/** Gateway images and the verified catalog's video families share Unified billing. */
export type GatewayModelId =
  "openai/gpt-image-2" | "bytedance/seedream-5-pro" | MediaVideoModelId;
export const isGatewayModel = (id: string): id is GatewayModelId =>
  id === "openai/gpt-image-2" ||
  id === "bytedance/seedream-5-pro" ||
  getGatewayModel(id)?.kind === "video";

/** What one generation bills: whole images, or seconds of video. */
export type MediaUnits = Readonly<{
  /** One image or one whole video second. */
  unit: "image" | "video_second";
  /** Number of delivered or admitted units. */
  units: number;
}>;

/** Billing units for validated settings; video bills its requested length. */
export function mediaUnits(
  settings: MediaGenerationSettings,
  catalogue: MediaCatalogue = mediaModels,
): MediaUnits {
  const model = getMediaModel(settings.model, catalogue);
  if (model === undefined)
    throw new MediaSettingsError("billing units require a known Media model");
  if (model.kind === "video") {
    const checked = validateMediaGenerationSettings(
      {
        ...settings,
        references: settings.references?.map((reference) => ({ ...reference })),
      },
      catalogue,
    );
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
 * Any other size is billed in proportion to its pixels at the 1024x1024 rate
 * (1,056 tokens per 1,048,576 pixels, which reproduces the table's 1024x1536
 * row exactly and bounds its 1536x1024 row), rounded up; OpenAI publishes no
 * table for the larger sizes.
 */
const gptImageOutputTokens = new Map([
  ["1024x1024", 1_056],
  ["1024x1536", 1_584],
  ["1536x1024", 1_568],
]);
const gptImageTokensPerMegapixel = 1_056 / 1_048_576;
function gptImageOutputTokenCount(settings: MediaGenerationSettings): number {
  const known = gptImageOutputTokens.get(sizeOf(settings));
  return (
    known ??
    Math.ceil(settings.width * settings.height * gptImageTokensPerMegapixel)
  );
}
/**
 * USD per million tokens: text input, image input and image output, as
 * Cloudflare publishes them for this exact model.
 * https://developers.cloudflare.com/ai/models/openai/gpt-image-2/
 */
const gptImageRates = { input: 5, inputImage: 8, outputImage: 30 } as const;

/**
 * Upper bound on the image input tokens one reference adds. OpenAI publishes
 * no input-token rule for gpt-image-2, which always reads inputs at high
 * fidelity, so this applies the GPT Image high-fidelity rule OpenAI does
 * publish (images-vision guide, GPT Image 1): fit within 2048 px, cap the
 * short side at 512 px, 65 base + 129 per 512 px tile, plus 4,160 extra
 * tokens for a square image or 6,240 for any other aspect.
 * https://developers.openai.com/api/docs/guides/images-vision
 * Community measurements put gpt-image-2 at most 1,536 image tokens per
 * input, so this bound over-bills rather than under-bills; lower it only
 * against real gateway input-token counts.
 */
function gptImageReferenceTokens(
  reference: Readonly<{ width: number; height: number }>,
): number {
  const fit = Math.min(1, 2048 / Math.max(reference.width, reference.height));
  const short = Math.min(reference.width, reference.height) * fit;
  const scale = fit * Math.min(1, 512 / short);
  const tiles =
    Math.ceil((reference.width * scale) / 512) *
    Math.ceil((reference.height * scale) / 512);
  const aspect = reference.width === reference.height ? 4_160 : 6_240;
  return 65 + 129 * tiles + aspect;
}

const sizeOf = (settings: MediaGenerationSettings) =>
  `${String(settings.width)}x${String(settings.height)}`;

/** Milliunits (1 cent = 1,000) of provider cost, rounded up. */
export function estimateGatewayMilliunits(
  settings: MediaGenerationSettings,
  references: readonly Readonly<{ width: number; height: number }>[],
): number {
  if (settings.model === "openai/gpt-image-2") {
    const output = gptImageOutputTokenCount(settings);
    if (references.length !== (settings.references?.length ?? 0))
      throw new MediaSettingsError(
        "resolved references must match every admitted reference",
      );
    // A bound on prompt tokens: at most one token per character, plus one
    // text token OpenAI is observed to add per input image.
    const input = settings.prompt.length + references.length;
    const inputImage = references.reduce(
      (sum, reference) => sum + gptImageReferenceTokens(reference),
      0,
    );
    // tokens * USD/M * 100,000 milliunits/USD / 1,000,000 = tokens * rate / 10
    return Math.ceil(
      (output * gptImageRates.outputImage +
        input * gptImageRates.input +
        inputImage * gptImageRates.inputImage) /
        10,
    );
  }
  // Cloudflare prices Seedream 5 Pro at $0.045 per image, and $0.03 per input
  // image (none are sent); it states no price by size.
  // https://developers.cloudflare.com/ai/models/bytedance/seedream-5-pro/
  if (settings.model === "bytedance/seedream-5-pro") return 4_500;
  if (getGatewayModel(settings.model)?.kind === "video")
    return estimateVideoMilliunits(settings);
  throw new MediaSettingsError(`${settings.model} is not a gateway model`);
}

/**
 * One `images[]` entry for `openai/gpt-image-2`: a base64 data URI of a png,
 * jpeg or webp image (Cloudflare's published input schema).
 * https://developers.cloudflare.com/ai/models/openai/gpt-image-2/
 */
function gptImageReference(reference: MediaReferenceBytes): string {
  if (reference.format === "gif")
    throw new MediaSettingsError(
      "openai/gpt-image-2 accepts png, jpeg or webp reference images, not gif",
    );
  return imageDataUri(reference);
}

/** The provider JSON body for one validated gateway generation. */
export function gatewayInput(
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[] = [],
  outputFormat: "png" | "jpeg" | "webp" = "png",
) {
  if (settings.model === "openai/gpt-image-2") {
    const body = {
      prompt: settings.prompt,
      size: sizeOf(settings),
      quality: "medium",
      output_format: outputFormat,
    };
    if (references.length !== (settings.references?.length ?? 0))
      throw new MediaSettingsError(
        "resolved references must match every admitted reference",
      );
    if (references.length === 0) return body;
    return { ...body, images: references.map(gptImageReference) };
  }
  if (settings.model === "bytedance/seedream-5-pro") {
    if (references.length > 0)
      throw new MediaSettingsError(
        "bytedance/seedream-5-pro takes no reference images here",
      );
    // `watermark` is a required field; false adds none.
    return {
      prompt: settings.prompt,
      size: sizeOf(settings),
      watermark: false,
    };
  }
  const checked = validateMediaGenerationSettings({
    ...settings,
    references: settings.references?.map((reference) => ({ ...reference })),
  });
  const model = getGatewayModel(checked.model);
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
