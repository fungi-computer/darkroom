import { getMediaModel, MediaSettingsError } from "./model-catalog.js";

const MIN_VIDEO_REFERENCE_DIMENSION = 320;

/** One owner for both native fitting and the resolved-reference boundary. */
function sizing(modelId: string) {
  const model = getMediaModel(modelId);
  if (model === undefined) throw new MediaSettingsError("unknown Media model");
  return model.video === null && model.input.referenceDimension !== null
    ? { edge: "long" as const, dimension: model.input.referenceDimension }
    : { edge: "short" as const, dimension: MIN_VIDEO_REFERENCE_DIMENSION };
}

/** Aspect-preserving native resize; only video references may be enlarged. */
export function referenceImageTransform(
  modelId: string,
  width: number,
  height: number,
) {
  const rule = sizing(modelId);
  const edge =
    rule.edge === "short" ? Math.min(width, height) : Math.max(width, height);
  const ratio =
    rule.edge === "short"
      ? rule.dimension / edge
      : Math.min(1, rule.dimension / edge);
  // A video's bounding box must not round its long edge down and squeeze
  // the actual decoded short edge below the provider minimum.
  const round = rule.edge === "short" ? Math.ceil : Math.round;
  return {
    width: Math.max(1, round(width * ratio)),
    height: Math.max(1, round(height * ratio)),
    // Small video frames must grow; image references must never grow.
    fit: rule.edge === "short" ? ("contain" as const) : ("scale-down" as const),
  };
}

/** Validate actual decoded output, rather than trusting requested resize dimensions. */
export function referenceImageSizeIsValid(
  modelId: string,
  width: number,
  height: number,
): boolean {
  const rule = sizing(modelId);
  return rule.edge === "short"
    ? Math.min(width, height) >= rule.dimension
    : Math.max(width, height) <= rule.dimension;
}

/** The encoding the selected model's fitted references are sent in. */
export function referenceImageFormat(modelId: string) {
  const model = getMediaModel(modelId);
  if (model === undefined) throw new MediaSettingsError("unknown Media model");
  return model.input.referenceFormat === "webp"
    ? ("image/webp" as const)
    : ("image/png" as const);
}
