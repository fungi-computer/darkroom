import {
  getGatewayModel,
  getMediaModel,
  mediaModels,
  MediaSettingsError,
  transformMilliunits,
  type MediaCatalogue,
} from "./model-catalog.js";
import {
  validateMediaGenerationSettings,
  mediaSettingsInput,
  estimateVideoMilliunits,
  type MediaAudioReferenceBytes,
  type MediaGenerationSettings,
  type MediaReferenceBytes,
} from "./index.js";
import type {
  MediaAudioModelId,
  MediaBillingUnit,
  MediaVideoModelId,
} from "./model-catalog.js";
import { mediaBillingUnit } from "./model-catalog.js";
import { AUDIO_CHARACTER_BLOCK } from "./model-catalog.js";
import {
  buildElevenLabsInput,
  estimateElevenLabsMilliunits,
} from "./audio-providers/elevenlabs.js";
import { imageDataUri } from "./video-providers/reference-encoding.js";
import {
  videoProviderAdapters,
  type CheckedVideoSettings,
} from "./video-providers/index.js";

/** Gateway images and the verified catalog's video and audio families share Unified billing. */
export type GatewayModelId =
  | "openai/gpt-image-2"
  | "bytedance/seedream-5-pro"
  | "bria/remove-background"
  | "pruna/p-image-upscale"
  | MediaVideoModelId
  | MediaAudioModelId;
export const isGatewayModel = (id: string): id is GatewayModelId => {
  if (
    id === "openai/gpt-image-2" ||
    id === "bytedance/seedream-5-pro" ||
    id === "bria/remove-background" ||
    id === "pruna/p-image-upscale"
  )
    return true;
  const kind = getGatewayModel(id)?.kind;
  return kind === "video" || kind === "audio";
};

/** What one generation bills, in the unit its catalog entry names. */
export type MediaUnits = Readonly<{
  /** The model's `billingUnit`. */
  unit: MediaBillingUnit;
  /** Number of delivered or admitted units. */
  units: number;
}>;

/** Re-run the settings grammar over already-normalized settings. */
const revalidate = (
  settings: MediaGenerationSettings,
  catalogue: MediaCatalogue = mediaModels,
) => validateMediaGenerationSettings(mediaSettingsInput(settings), catalogue);

/** Billing units for validated settings; video bills its requested length. */
export function mediaUnits(
  settings: MediaGenerationSettings,
  catalogue: MediaCatalogue = mediaModels,
): MediaUnits {
  const model = getMediaModel(settings.model, catalogue);
  if (model === undefined)
    throw new MediaSettingsError("billing units require a known Media model");
  const unit = mediaBillingUnit(model);
  if (unit === "image") return { unit, units: 1 };
  const checked = revalidate(settings, catalogue);
  if (unit === "audio_character_block")
    return {
      unit,
      units: Math.ceil(checked.prompt.length / AUDIO_CHARACTER_BLOCK),
    };
  if (checked.durationSeconds === undefined)
    throw new MediaSettingsError(
      unit === "video_second"
        ? "video settings need a duration"
        : "music settings need a length",
    );
  return { unit, units: checked.durationSeconds };
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
  const { width, height } = settings;
  if (width === undefined || height === undefined)
    throw new MediaSettingsError("an image needs a width and a height");
  const known = gptImageOutputTokens.get(sizeOf(settings));
  return known ?? Math.ceil(width * height * gptImageTokensPerMegapixel);
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
  const model = getGatewayModel(settings.model);
  if (model?.transform != null) {
    // Published per-image prices, held in the catalog's transform facts.
    const price = transformMilliunits(
      model.transform,
      settings.targetMegapixels,
    );
    if (price === undefined)
      throw new MediaSettingsError(
        `${model.id} has no price for this output size`,
      );
    return price;
  }
  if (model?.kind === "video") return estimateVideoMilliunits(settings);
  if (model?.kind === "audio")
    return estimateElevenLabsMilliunits(revalidate(settings), model);
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
  audioReferences: readonly MediaAudioReferenceBytes[] = [],
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
  if (
    settings.model === "bria/remove-background" ||
    settings.model === "pruna/p-image-upscale"
  ) {
    const [source, ...extra] = references;
    if (source === undefined || extra.length > 0)
      throw new MediaSettingsError(`${settings.model} takes one source image`);
    if (source.format !== "png" && source.format !== "jpeg")
      throw new MediaSettingsError(
        `${settings.model} accepts png or jpeg source images`,
      );
    // Always the bytes as a data URI, never a URL to our storage.
    // https://developers.cloudflare.com/ai/models/bria/remove-background/
    const image = imageDataUri(source);
    if (settings.model === "bria/remove-background")
      return { image, preserve_alpha: true };
    // Every field is marked required on the model page; the values are its
    // defaults except the output encoding (see the catalog entry).
    // https://developers.cloudflare.com/ai/models/pruna/p-image-upscale/
    return {
      image,
      target: settings.targetMegapixels ?? 4,
      output_format: "webp",
      output_quality: 90,
      enhance_details: false,
      enhance_realism: false,
      disable_safety_checker: false,
    };
  }
  const checked = revalidate(settings);
  const model = getGatewayModel(checked.model);
  if (model?.audio != null) return buildElevenLabsInput(checked, model);
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
  if (audioReferences.length !== (checked.audioReferences?.length ?? 0))
    throw new MediaSettingsError(
      "resolved audio references must match every admitted audio reference",
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
    audioReferences,
  );
}
