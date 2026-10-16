import { getMediaModel, MediaSettingsError } from "./model-catalog.js";
import { neuronsToMilliunits } from "./neurons.js";
import * as z from "zod";

/** Dimensions and optional settings used by the deterministic image quote. */
export type ImageParams = {
  /** Output height in pixels. */
  readonly height: number;
  /** Reference dimensions counted in the quote. */
  readonly references?: readonly ImageReference[];
  /** Inference steps, using catalog defaults when omitted. */
  readonly steps?: number;
  /** Output width in pixels. */
  readonly width: number;
};

/** Reference-image dimensions used to estimate provider work. */
export type ImageReference = {
  /** Reference height in pixels. */
  readonly height: number;
  /** Reference width in pixels. */
  readonly width: number;
};

const TILE = 512;
const MAX_DIMENSION = 4_096;
const MAX_REFERENCES = 4;

const imageParamsSchema = z.lazy(() =>
  z
    .object({
      width: z.number().int().min(1).max(MAX_DIMENSION),
      height: z.number().int().min(1).max(MAX_DIMENSION),
      steps: z.number().int().min(1).optional(),
      references: z
        .array(
          z
            .object({
              width: z.number().int().min(1).max(MAX_DIMENSION),
              height: z.number().int().min(1).max(MAX_DIMENSION),
            })
            .strict(),
        )
        .max(MAX_REFERENCES)
        .optional(),
    })
    .strict(),
);

const invalid = (message: string): never => {
  throw new MediaSettingsError(`image cost parameters are invalid: ${message}`);
};

const tiles = (width: number, height: number): number =>
  Math.ceil(width / TILE) * Math.ceil(height / TILE);

const checked = (modelId: string, params: ImageParams): ImageParams => {
  const parsed = imageParamsSchema.safeParse(params);
  if (!parsed.success)
    return invalid("dimensions, steps, or references are invalid");
  const candidate = parsed.data;
  const references = candidate.references ?? [];
  const model = getMediaModel(modelId);
  if (model === undefined)
    throw new MediaSettingsError(`Image cost unknown for model "${modelId}"`);
  if (references.length > model.input.maxReferences)
    return invalid(`${modelId} does not accept references`);
  const normalized = {
    width: candidate.width,
    height: candidate.height,
    references,
  };
  if (candidate.steps !== undefined)
    return { ...normalized, steps: candidate.steps };
  return normalized;
};

/** Estimate Workers AI neurons from a validated image request. */
export const estimateImageNeurons = (
  modelId: string,
  params: ImageParams,
): number => {
  const p = checked(modelId, params);
  const outputTiles = tiles(p.width, p.height);
  const inputTiles = (p.references ?? []).reduce(
    (sum, reference) => sum + tiles(reference.width, reference.height),
    0,
  );
  switch (modelId) {
    case "@cf/black-forest-labs/flux-1-schnell":
      return outputTiles * 4.8 + (p.steps ?? 4) * 9.6;
    case "@cf/black-forest-labs/flux-2-klein-4b":
      return inputTiles * 5.37 + outputTiles * 26.05;
    case "@cf/black-forest-labs/flux-2-dev":
      return (
        inputTiles * (p.steps ?? 20) * 19.09 +
        outputTiles * (p.steps ?? 20) * 37.27
      );
    case "@cf/black-forest-labs/flux-2-klein-9b": {
      const outputMp = (p.width / 1024) * (p.height / 1024);
      const outputCost =
        Math.min(outputMp, 1) * 1363.64 + Math.max(0, outputMp - 1) * 181.82;
      const inputMp = (p.references ?? []).reduce(
        (sum, reference) =>
          sum + (reference.width / 1024) * (reference.height / 1024),
        0,
      );
      return (outputMp < 1 ? 1363.64 : outputCost) + inputMp * 181.82;
    }
    case "@cf/leonardo/lucid-origin":
      return outputTiles * 636 + (p.steps ?? 20) * 12;
    case "@cf/leonardo/phoenix-1.0":
      return outputTiles * 530 + (p.steps ?? 25) * 10;
    default:
      // checked() owns this rejection; keep the switch exhaustive at runtime.
      throw new MediaSettingsError(`Image cost unknown for model "${modelId}"`);
  }
};

/** Quote the same estimate in milliunits (1 cent = 1,000 milliunits). */
export const estimateImageMilliunits = (
  modelId: string,
  params: ImageParams,
): number => neuronsToMilliunits(estimateImageNeurons(modelId, params));
