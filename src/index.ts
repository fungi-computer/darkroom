import * as z from "zod";
import { reportCatchFailure } from "./failure.js";
import { referenceImageSizeIsValid } from "./reference-image-size.js";
export { MAX_REFERENCE_DIMENSION } from "./reference-image-size.js";
import {
  getMediaModel,
  MAX_REFERENCE_COUNT,
  MediaSettingsError,
  mediaVideoModelIdSchema,
  mediaVideoResolutionSchema,
  mediaVideoAspectRatioSchema,
  mediaVideoReferenceRoleSchema,
  MAX_MEDIA_PROMPT_LENGTH,
  type MediaVideoReferenceRole,
  type MediaVideoModelId,
  type MediaVideoResolution,
  type MediaVideoAspectRatio,
} from "./model-catalog.js";

export { mediaFailureStageSchema } from "./execution-error.js";

export {
  MAX_MEDIA_PROMPT_LENGTH,
  getMediaModel,
  MAX_REFERENCE_COUNT,
  listMediaModels,
  mediaModelInputSchema,
  mediaModelSchema,
  mediaRequestedImageFormatSchema,
  mediaModels,
  mediaModelTierSchema,
  MediaSettingsError,
  mediaVideoModelIdSchema,
  mediaVideoResolutionSchema,
  mediaVideoAspectRatioSchema,
  mediaVideoReferenceRoleSchema,
  mediaVideoFormatSchema,
  mediaVideoSchema,
} from "./model-catalog.js";
export type {
  MediaModel,
  MediaModelInput,
  MediaModelTier,
  MediaVideoModelId,
  MediaVideoResolution,
  MediaVideoAspectRatio,
  MediaVideoReferenceRole,
  MediaVideoModel,
  MediaVideoFormat,
} from "./model-catalog.js";

/** A reference file selected by the host, with its destination identity and path. */
export type MediaReference = Readonly<{
  /** Host-admitted destination or reference identity. */
  computerId: string;
  /** Fixed destination or reference file path. */
  path: string;
  /** Video reference role; a single untagged host reference means first frame. */
  role?: MediaVideoReferenceRole;
}>;
/** Supported still-image encodings. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";
/** MIME type corresponding to a supported image encoding. */
export type ImageMimeType = `image/${ImageFormat}`;
/** A saved generation: an image, or an MP4 from a video model. */
export type MediaOutputFormat = ImageFormat | "mp4";
/** Decoded reference bytes and the dimensions sent to the provider. */
export type MediaReferenceBytes = Readonly<{
  /** Decoded reference image bytes. */
  bytes: Uint8Array;
  /** Actual reference image encoding. */
  format: ImageFormat;
  /** Reference width in pixels. */
  width: number;
  /** Reference height in pixels. */
  height: number;
  /** Optional filename sent with multipart input. */
  filename?: string;
}>;
/** Normalized model settings, including bounded host-selected references. */
export type MediaGenerationSettings = Readonly<{
  /** Catalog model identifier. */
  model: string;
  /** Trimmed generation prompt. */
  prompt: string;
  /** Requested image width or nominal video resolution/aspect selector. */
  width: number;
  /** Requested image height or nominal video resolution/aspect selector. */
  height: number;
  /** Model-specific inference steps. */
  steps?: number;
  /** Video models only: output length in whole seconds. */
  durationSeconds?: number;
  /** Video resolution selector, normalized from the catalog. */
  resolution?: MediaVideoResolution;
  /** Requested video aspect; a first image may override it upstream. */
  aspectRatio?: MediaVideoAspectRatio;
  /** Audio selection; omitted for Seedance when its default is undocumented. */
  generateAudio?: boolean;
  /** Host-authorized reference files. */
  references?: readonly MediaReference[];
}>;

/**
 * One Media provider call: validated settings and reference bytes in, output
 * bytes out. Hosts may bind it to Workers AI or their own transport.
 */
export type MediaProvider = (
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[],
  signal?: AbortSignal,
  outputFormat?: "png" | "jpeg" | "webp",
) => Promise<
  Readonly<{
    /** Generated output bytes. */
    bytes: Uint8Array;
    /** Actual output encoding. */
    format: string;
  }>
>;

/** A decoded reference image, fitted for the selected model. */
export type FittedReferenceImage = Omit<MediaReferenceBytes, "filename">;
/** Decode and fit a reference: image long edge ≤512, video short edge ≥320. */
export type ReferenceImageFitter = (
  bytes: Uint8Array,
  model: string,
) => Promise<FittedReferenceImage>;

/** The long-edge bounds a viewer may ask for when fitting an image to look at. */
export const MIN_VIEW_DIMENSION = 256;
/** Maximum long-edge size accepted by an image viewer, in pixels. */
export const MAX_VIEW_DIMENSION = 512;
/** Decode a viewer long-edge size within the supported pixel bounds. */
export const viewDimensionSchema = z.lazy(() =>
  z.number().int().min(MIN_VIEW_DIMENSION).max(MAX_VIEW_DIMENSION),
);
/**
 * Decode one image and re-encode it for a model to look at: scaled within
 * `maxDimension` on the long edge (bounded by {@link viewDimensionSchema}) as
 * a lossy JPEG, so a viewer can step the dimension down to meet a byte budget.
 */
export type ImageViewFitter = (
  bytes: Uint8Array,
  maxDimension: number,
) => Promise<FittedReferenceImage>;

/** Reference images in one video request: every verified video model's catalog value. */
const MAX_VIDEO_REFERENCE_COUNT = 4;
/** Maximum decoded bytes per reference image. */
export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
/** Maximum retained still-image output bytes. */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const requiredString = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new MediaSettingsError(`${name} must not be blank`);
  return trimmed;
};
const boundedInteger = (
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new MediaSettingsError(
      `${name} must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
  return value;
};
const normalizeReference = (value: {
  computerId: string;
  path: string;
  role?: MediaVideoReferenceRole | undefined;
}): MediaReference => {
  const reference = {
    computerId: requiredString(value.computerId, "reference computerId"),
    path: requiredString(value.path, "reference path"),
  };
  if (value.role === undefined) return reference;
  return { ...reference, role: value.role };
};

/** Structural wire grammar for one Media generation request. */
export const mediaGenerationSettingsSchema = z
  .object({
    /** Provider catalog model identifier. */
    model: z.string().min(1).max(256),
    /** Generation prompt; each model's `maxPromptLength` is enforced on top of this ceiling. */
    prompt: z.string().min(1).max(MAX_MEDIA_PROMPT_LENGTH),
    /** Requested image width or nominal video selector, not decoded MP4 dimensions. */
    width: z.number().int().min(1).max(5_040),
    /** Requested image height or nominal video selector, not decoded MP4 dimensions. */
    height: z.number().int().min(1).max(5_040),
    /** Model-specific inference step count. */
    steps: z.number().int().optional(),
    /** Requested video length in whole seconds. */
    durationSeconds: z.number().int().optional(),
    /** Video resolution; must match the nominal width/height selector. */
    resolution: mediaVideoResolutionSchema.optional(),
    /** Video aspect; must match the nominal width/height selector. */
    aspectRatio: mediaVideoAspectRatioSchema.optional(),
    /** Video audio selection. */
    generateAudio: z.boolean().optional(),
    /** Host-authorized reference images. */
    references: z
      .array(
        z
          .object({
            /** Host-admitted destination or reference identity. */
            computerId: z.string().min(1).max(256),
            /** Fixed destination or reference file path. */
            path: z.string().min(1).max(4_096),
            /** Video-only reference role. */
            role: mediaVideoReferenceRoleSchema.optional(),
          })
          .strict(),
      )
      .max(MAX_REFERENCE_COUNT)
      .optional(),
  })
  .strict();
/** Caller settings before model defaults and refinements are applied. */
export type MediaGenerationSettingsInput = z.input<
  typeof mediaGenerationSettingsSchema
>;
/** A reference may select another Computer; identity never grants access. */
export const mediaGenerationSelectionSchema =
  mediaGenerationSettingsSchema.extend({
    /** Host-authorized reference images. */
    references: z
      .array(
        z
          .object({
            /** Omit for the selected Computer; the host authorizes every named Computer. */
            computerId: z.string().min(1).max(256).optional(),
            /** Fixed destination or reference file path. */
            path: z.string().min(1).max(4_096),
            /** Video-only reference role. */
            role: mediaVideoReferenceRoleSchema.optional(),
          })
          .strict(),
      )
      .max(MAX_REFERENCE_COUNT)
      .optional(),
  });
/** Generation settings with reference paths resolved by an admitting host. */
export type MediaGenerationSelection = z.output<
  typeof mediaGenerationSelectionSchema
>;
type MutableMediaGenerationSettings<Reference> = {
  model: string;
  prompt: string;
  width: number;
  height: number;
  steps?: number;
  durationSeconds?: number;
  /** Video resolution selector, normalized from the catalog. */
  resolution?: MediaVideoResolution;
  /** Requested video aspect; a first image may override it upstream. */
  aspectRatio?: MediaVideoAspectRatio;
  /** Audio selection; omitted for Seedance when its default is undocumented. */
  generateAudio?: boolean;
  references?: readonly Reference[];
};

/** Validate caller settings and apply retained model defaults. */
export const validateMediaGenerationSettings = (
  raw: MediaGenerationSettingsInput,
): MediaGenerationSettings => {
  const parsed = mediaGenerationSettingsSchema.safeParse(raw);
  if (!parsed.success)
    throw new MediaSettingsError("generation settings are invalid");
  return normalizeGenerationSettings(parsed.data, normalizeReference);
};

/** Validate selections without granting Computer authority. */
export const validateMediaGenerationSelection = (
  raw: z.input<typeof mediaGenerationSelectionSchema>,
): Readonly<
  Omit<MediaGenerationSettings, "references"> & {
    /** Host-authorized reference images. */
    references?: readonly Readonly<{
      /** Fixed destination or reference file path. */
      path: string;
      /** Optional reference Computer; authorization remains host-owned. */
      computerId?: string;
      /** Video-only reference role. */
      role?: MediaVideoReferenceRole;
    }>[];
  }
> => {
  const parsed = mediaGenerationSelectionSchema.safeParse(raw);
  if (!parsed.success)
    throw new MediaSettingsError("generation settings are invalid");
  return normalizeGenerationSettings(parsed.data, (reference) => {
    const path = requiredString(reference.path, "reference path");
    const selection =
      reference.computerId === undefined
        ? { path }
        : { path, computerId: reference.computerId };
    if (reference.role === undefined) return selection;
    return { ...selection, role: reference.role };
  });
};

function normalizeGenerationSettings<
  InputReference extends {
    path: string;
    role?: MediaVideoReferenceRole | undefined;
  },
  Reference extends { path: string; role?: MediaVideoReferenceRole },
>(
  input: Omit<z.output<typeof mediaGenerationSettingsSchema>, "references"> & {
    /** Host-authorized reference images. */
    references?: readonly InputReference[] | undefined;
  },
  normalize: (reference: InputReference) => Reference,
): Readonly<MutableMediaGenerationSettings<Reference>> {
  const modelId = requiredString(input.model, "model");
  const model = getMediaModel(modelId);
  if (model === undefined)
    throw new MediaSettingsError(`unknown Media model "${modelId}"`);
  const prompt = requiredString(input.prompt, "prompt");
  if (prompt.length > model.maxPromptLength)
    throw new MediaSettingsError(
      `${model.id} prompt is ${String(prompt.length)} characters; its limit is ${String(model.maxPromptLength)}`,
    );
  const maximumDimension = model.video === null ? 4_096 : 5_040;
  const width = boundedInteger(input.width, "width", 1, maximumDimension);
  const height = boundedInteger(input.height, "height", 1, maximumDimension);
  if (
    model.input.dimensions === "own" &&
    (width < 256 ||
      height < 256 ||
      width > (model.input.maxDimension ?? 4_096) ||
      height > (model.input.maxDimension ?? 4_096))
  )
    throw new MediaSettingsError(
      `${model.id} accepts dimensions from 256 through ${String(model.input.maxDimension)}`,
    );

  if (
    model.sizes !== null &&
    !model.sizes.includes(`${String(width)}x${String(height)}`)
  )
    throw new MediaSettingsError(
      `${model.id} accepts only these sizes: ${model.sizes.join(", ")}`,
    );
  let durationSeconds: number | undefined;
  if (model.video === null) {
    if (
      input.resolution !== undefined ||
      input.aspectRatio !== undefined ||
      input.generateAudio !== undefined ||
      input.references?.some((reference) => reference.role !== undefined)
    )
      throw new MediaSettingsError(
        `${model.id} does not take video settings or frame roles`,
      );
    if (input.durationSeconds !== undefined)
      throw new MediaSettingsError(`${model.id} does not take a duration`);
  } else {
    durationSeconds = boundedInteger(
      input.durationSeconds ?? model.video.defaultSeconds,
      "durationSeconds",
      model.video.minSeconds,
      model.video.maxSeconds,
    );
    if (!model.video.durations.includes(durationSeconds))
      throw new MediaSettingsError(
        `${model.id} accepts durationSeconds ${model.video.durations.join(", ")}`,
      );
  }

  let steps: number | undefined;
  if (input.steps !== undefined && model.input.steps === "fixed")
    throw new MediaSettingsError(
      `${model.id} uses fixed steps and cannot be adjusted`,
    );
  if (input.steps !== undefined) {
    steps = boundedInteger(input.steps, "steps", 1, Number.MAX_SAFE_INTEGER);
    if (model.input.maxSteps !== null && steps > model.input.maxSteps)
      throw new MediaSettingsError(
        `${model.id} accepts at most ${String(model.input.maxSteps)} steps`,
      );
  } else if (
    model.input.steps !== "fixed" &&
    model.input.defaultSteps !== null
  ) {
    steps = model.input.defaultSteps;
  }

  let references: readonly Reference[] | undefined;
  if (input.references !== undefined) {
    if (input.references.length > model.input.maxReferences)
      throw new MediaSettingsError(
        `${model.id} accepts at most ${String(model.input.maxReferences)} reference images`,
      );
    references = input.references.map(normalize);
  }
  const normalized: MutableMediaGenerationSettings<Reference> = {
    model: model.id,
    prompt,
    width,
    height,
  };
  if (steps !== undefined) normalized.steps = steps;
  if (durationSeconds !== undefined)
    normalized.durationSeconds = durationSeconds;
  if (model.video !== null) {
    const video = model.video;
    const format = video.formats.find(
      (candidate) => candidate.width === width && candidate.height === height,
    );
    if (format === undefined)
      throw new MediaSettingsError("unsupported video size");
    if (
      (input.resolution !== undefined &&
        input.resolution !== format.resolution) ||
      (input.aspectRatio !== undefined &&
        input.aspectRatio !== format.aspectRatio)
    )
      throw new MediaSettingsError(
        "video selectors must match nominal width and height",
      );
    normalized.resolution = format.resolution;
    normalized.aspectRatio = format.aspectRatio;
    const generateAudio = input.generateAudio ?? video.defaultGenerateAudio;
    if (generateAudio !== null) normalized.generateAudio = generateAudio;
    if (references !== undefined) {
      references = references.map((reference) => ({
        ...reference,
        role: reference.role ?? mediaVideoReferenceRoleSchema.enum.first,
      }));
      const roles = references.map((reference) => reference.role);
      const refused = roles.find(
        (role) => role === undefined || !video.referenceRoles.includes(role),
      );
      if (refused !== undefined || roles.includes(undefined))
        throw new MediaSettingsError(
          refused === "last-frame"
            ? `${model.label} has no last frame`
            : `${model.label} does not take ${String(refused)} images`,
        );
      const first = roles.filter((role) => role === "first-frame").length;
      const last = roles.filter((role) => role === "last-frame").length;
      const referenceCount = roles.filter(
        (role) => role === "reference",
      ).length;
      if (first > 1 || last > 1)
        throw new MediaSettingsError(
          video.referenceRoles.includes("last-frame")
            ? `${model.label} takes one first frame and one last frame`
            : `${model.label} takes one first frame`,
        );
      if (last > 0 && first !== 1)
        throw new MediaSettingsError(
          "A last frame needs a first frame as well",
        );
      if (referenceCount > 0 && first + last > 0)
        throw new MediaSettingsError(
          "Frames and references cannot be mixed; use a first/last frame or references",
        );
      if (referenceCount > video.maxReferenceImages)
        throw new MediaSettingsError(
          `${model.label} takes up to ${String(video.maxReferenceImages)} reference images`,
        );
      if (
        referenceCount > 0 &&
        !video.referenceResolutions.includes(format.resolution)
      )
        throw new MediaSettingsError(
          `${model.label} takes reference images only at ${video.referenceResolutions.join(", ")}`,
        );
    }
  }
  if (references !== undefined)
    normalized.references = Object.freeze(references);
  return Object.freeze(normalized);
}

/** Path-only video reference; the host supplies authority and reads its bytes. */
export const mediaVideoReferenceSchema = z.lazy(() =>
  z.strictObject({
    /** Selected image path, trimmed and nonblank after validation. */
    path: z.string().min(1).max(4_096),
    /** Explicit first frame, last frame, or reference-image role. */
    role: mediaVideoReferenceRoleSchema,
  }),
);
/** One path-only video reference. */
export type MediaVideoReference = z.output<typeof mediaVideoReferenceSchema>;
/** Neutral video selection; model-specific combinations are checked by validateMediaVideoSelection. */
export const mediaVideoSelectionSchema = z.lazy(() =>
  z.strictObject({
    /** Verified catalog model identifier. */
    model: mediaVideoModelIdSchema,
    /** Trimmed prompt; the selected model's `maxPromptLength` is enforced on top of this ceiling. */
    prompt: z.string().min(1).max(MAX_MEDIA_PROMPT_LENGTH),
    /** Model-specific resolution, default 720p. */
    resolution: mediaVideoResolutionSchema.optional(),
    /** Model-specific aspect, default 16:9. */
    aspectRatio: mediaVideoAspectRatioSchema.optional(),
    /** Whole seconds; Seedance 4–12, Veo exactly 4/6/8, MiniMax H3 Max 5–15. */
    durationSeconds: z.number().int().min(4).max(15).optional(),
    /** Veo defaults true; Seedance omits the provider option when unset;
     * MiniMax H3 Max has no audio field and refuses an explicit choice. */
    generateAudio: z.boolean().optional(),
    /** Up to four references, with provider-specific roles and mode limits. */
    references: z
      .array(mediaVideoReferenceSchema)
      .max(MAX_VIDEO_REFERENCE_COUNT)
      .optional(),
  }),
);
/** Caller video selection before defaults and model-specific refinements. */
export type MediaVideoSelectionInput = z.input<
  typeof mediaVideoSelectionSchema
>;
/** Normalized path-only video settings, ready for host-authorized reference hydration. */
export type MediaVideoSelection = Readonly<{
  /** Verified catalog video identifier. */
  model: MediaVideoModelId;
  /** Trimmed, bounded prompt. */
  prompt: string;
  /** Nominal width selecting resolution/aspect, not decoded MP4 dimensions. */
  width: number;
  /** Nominal height selecting resolution/aspect, not decoded MP4 dimensions. */
  height: number;
  /** Validated provider resolution. */
  resolution: MediaVideoResolution;
  /** Validated requested aspect. */
  aspectRatio: MediaVideoAspectRatio;
  /** Validated output duration in whole seconds. */
  durationSeconds: number;
  /** Explicit audio choice, omitted for Seedance when unset. */
  generateAudio?: boolean;
  /** Normalized paths and required frame/reference roles. */
  references?: readonly Readonly<MediaVideoReference>[];
}>;
type MutableMediaVideoSelection = {
  -readonly [Field in keyof MediaVideoSelection]: MediaVideoSelection[Field];
};

/** Validate supported model/size/duration/reference combinations before authority or billing admission. */
export function validateMediaVideoSelection(
  raw: MediaVideoSelectionInput,
): MediaVideoSelection {
  const parsed = mediaVideoSelectionSchema.safeParse(raw);
  if (!parsed.success)
    throw new MediaSettingsError("video selection is invalid");
  const input = parsed.data;
  const model = getMediaModel(input.model);
  if (model?.video == null) throw new MediaSettingsError("unknown video model");
  const resolution = input.resolution ?? model.video.defaultResolution;
  const aspectRatio = input.aspectRatio ?? model.video.defaultAspectRatio;
  const format = model.video.formats.find(
    (candidate) =>
      candidate.resolution === resolution &&
      candidate.aspectRatio === aspectRatio,
  );
  if (format === undefined)
    throw new MediaSettingsError(
      `${model.id} does not accept this resolution/aspect`,
    );
  const normalized = validateMediaGenerationSelection({
    ...input,
    width: format.width,
    height: format.height,
  });
  const selection: MutableMediaVideoSelection = {
    ...format,
    model: input.model,
    prompt: normalized.prompt,
    durationSeconds: normalized.durationSeconds ?? model.video.defaultSeconds,
  };
  if (normalized.generateAudio !== undefined)
    selection.generateAudio = normalized.generateAudio;
  if (normalized.references !== undefined)
    selection.references = Object.freeze(
      normalized.references.map((reference) =>
        Object.freeze(mediaVideoReferenceSchema.parse(reference)),
      ),
    );
  return Object.freeze(selection);
}

/** Host-authorized reader for decoded reference images. */
export type MediaReferenceReader = Readonly<{
  /** Authorize and fit one reference for the selected catalog model. */
  read: (
    reference: MediaReference,
    model: string,
  ) => Promise<MediaReferenceBytes>;
}>;
const imageFormats = new Set<ImageFormat>(["png", "jpeg", "gif", "webp"]);

/** Resolve only provider-accepted references through the caller's reader. */
export const resolveMediaReferences = async (
  settings: MediaGenerationSettings,
  reader: MediaReferenceReader,
): Promise<readonly MediaReferenceBytes[]> => {
  const model = getMediaModel(settings.model);
  if (model === undefined) throw new MediaSettingsError("unknown Media model");
  const references = settings.references ?? [];
  if (references.length > model.input.maxReferences)
    throw new MediaSettingsError(
      `${model.id} accepts at most ${String(model.input.maxReferences)} reference images`,
    );
  const resolved: MediaReferenceBytes[] = [];
  for (const reference of references) {
    const image = await reader.read(reference, settings.model);
    if (
      !imageFormats.has(image.format) ||
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      !referenceImageSizeIsValid(settings.model, image.width, image.height) ||
      !(image.bytes instanceof Uint8Array) ||
      image.bytes.byteLength === 0 ||
      image.bytes.byteLength > MAX_REFERENCE_BYTES
    )
      throw new MediaSettingsError(
        `reference ${reference.computerId}:${reference.path} exceeds the bounded image contract`,
      );
    resolved.push(Object.freeze({ ...image }));
  }
  return Object.freeze(resolved);
};

/** Provider JSON image input for models without multipart references. */
export type MediaJsonBody = Readonly<{
  /** Generation prompt. */
  prompt: string;
  /** Optional model-native output width. */
  width?: number;
  /** Optional model-native output height. */
  height?: number;
  /** Steps for models using the steps field. */
  steps?: number;
  /** Steps for models using the num_steps field. */
  num_steps?: number;
}>;
type MutableMediaJsonBody = {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  num_steps?: number;
};
/** A model-specific JSON body or multipart form ready for transport. */
export type MediaProviderPayload =
  | Readonly<{
      /** Provider input transport. */
      transport: "json";
      /** Model-native JSON input. */
      body: MediaJsonBody;
    }>
  | Readonly<{
      /** Provider input transport. */
      transport: "multipart";
      /** Platform-encoded multipart image input. */
      body: FormData;
    }>;
const mimeForFormat = (format: ImageFormat): ImageMimeType => `image/${format}`;

/** Build the exact JSON or multipart payload required by a retained model. */
export const buildProviderInput = (
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[] = [],
): MediaProviderPayload => {
  const model = getMediaModel(settings.model);
  if (model === undefined) throw new MediaSettingsError("unknown Media model");
  if (model.sizes !== null)
    throw new MediaSettingsError(`${model.id} runs through the AI Gateway`);
  if (references.length > model.input.maxReferences)
    throw new MediaSettingsError(
      `${model.id} accepts at most ${String(model.input.maxReferences)} reference images`,
    );
  if (model.input.referenceField === null && references.length > 0)
    throw new MediaSettingsError(`${model.id} does not accept references`);
  if (model.input.transport === "json") {
    const body: MutableMediaJsonBody = {
      prompt: settings.prompt,
    };
    if (model.input.dimensions === "own") {
      body.width = settings.width;
      body.height = settings.height;
    }
    if (settings.steps !== undefined && model.input.steps === "steps")
      body.steps = settings.steps;
    if (settings.steps !== undefined && model.input.steps === "num_steps")
      body.num_steps = settings.steps;
    return Object.freeze({
      transport: "json",
      body: Object.freeze(body),
    });
  }
  const body = new FormData();
  body.append("prompt", settings.prompt);
  if (model.input.dimensions === "own") {
    body.append("width", String(settings.width));
    body.append("height", String(settings.height));
  }
  if (settings.steps !== undefined && model.input.steps === "steps")
    body.append("steps", String(settings.steps));
  references.forEach((reference, index) => {
    body.append(
      `${model.input.referenceField ?? "input_image_"}${String(index)}`,
      new Blob([new Uint8Array(reference.bytes).buffer], {
        type: mimeForFormat(reference.format),
      }),
      reference.filename ?? `reference-${String(index)}`,
    );
  });
  return Object.freeze({
    transport: "multipart",
    body,
  });
};

/** One image in a provider envelope, encoded inline or available at a URL. */
export type MediaProviderImageEntry = Readonly<{
  /** Inline base64 image data. */
  base64?: string | undefined;
  /** Inline encoded image data. */
  data?: string | undefined;
  /** HTTP image URL fetched through the host. */
  url?: string | undefined;
}>;
/** Parsed provider representation before conversion to bounded image bytes. */
export type MediaProviderOutput =
  | Readonly<{
      /** Outcome or model-kind discriminant. */
      kind: "bytes";
      /** Generated output bytes. */
      bytes: Uint8Array;
    }>
  | Readonly<{
      /** Outcome or model-kind discriminant. */
      kind: "response";
      /** Provider response or encoded image response. */
      response: Response;
    }>
  | Readonly<{
      /** Outcome or model-kind discriminant. */
      kind: "encoded";
      /** Inline provider image representation. */
      encoded: string;
    }>
  | Readonly<{
      /** Outcome or model-kind discriminant. */
      kind: "entries";
      /** Provider output image entries. */
      entries: readonly MediaProviderImageEntry[];
    }>;
const providerEntrySchema = z.lazy(() =>
  z
    .object({
      /** Base64-encoded image data. */
      base64: z.string().optional(),
      /** Encoded inline image data. */
      data: z.string().optional(),
      /** HTTP provider output URL. */
      url: z
        .url()
        .refine(
          (value) => /^https?:\/\//iu.test(value),
          "provider image URLs must use HTTP(S)",
        )
        .optional(),
    })
    .strict(),
);
const providerEnvelopeSchema = z.lazy(() =>
  z.union([
    z.object({
      /** Encoded provider image. */
      image: z.string().min(1),
    }),
    z.object({
      /** Provider image entries. */
      image: z.array(providerEntrySchema),
    }),
    z.object({
      /** Provider output image entries. */
      images: z.array(providerEntrySchema),
    }),
  ]),
);

/** Decode the Workers AI binding's raw output at the provider boundary. */
export const mediaProviderWireSchema = z.lazy(() =>
  z.union([
    providerEnvelopeSchema,
    z.instanceof(Uint8Array),
    z.instanceof(Response),
    z.custom<ReadableStream<Uint8Array>>(
      (value) => value instanceof ReadableStream,
    ),
  ]),
);
/** Supported raw provider representations, decoded by mediaProviderWireSchema. */
export type MediaProviderWire = z.output<typeof mediaProviderWireSchema>;
/** Native Workers AI output or an already decoded provider representation. */
export type MediaAiResult = Awaited<ReturnType<Ai["run"]>> | MediaProviderWire;

/** Parse the provider wire envelope before normalization. */
export const parseMediaProviderOutput = (
  value: MediaProviderWire,
): MediaProviderOutput => {
  if (value instanceof Uint8Array)
    return {
      kind: "bytes",
      bytes: value,
    };
  if (value instanceof Response)
    return {
      kind: "response",
      response: value,
    };
  if (value instanceof ReadableStream)
    return {
      kind: "response",
      response: new Response(value),
    };
  const parsed = providerEnvelopeSchema.parse(value);
  if ("image" in parsed)
    return Array.isArray(parsed.image)
      ? {
          kind: "entries",
          entries: parsed.image,
        }
      : {
          kind: "encoded",
          encoded: parsed.image,
        };
  return {
    kind: "entries",
    entries: parsed.images,
  };
};

const sniffImageFormat = (bytes: Uint8Array): ImageFormat | undefined => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "jpeg";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return "gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "webp";
  return undefined;
};
const decodeEncoded = (
  value: string,
  maximumBytes: number,
): Uint8Array | undefined => {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  if (payload.length > Math.ceil((maximumBytes * 4) / 3) + 4) return undefined;
  const encoded = z.base64().safeParse(payload);
  if (!encoded.success) return undefined;
  const binary = atob(encoded.data);
  if (binary.length === 0 || binary.length > maximumBytes) return undefined;
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
const encodedExceedsBound = (value: string, maximumBytes: number): boolean => {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  return payload.length > Math.ceil((maximumBytes * 4) / 3) + 4;
};
const declaredDataUrlFormat = (value: string): ImageFormat | undefined => {
  if (!value.startsWith("data:")) return undefined;
  const comma = value.indexOf(",");
  if (comma < 0) return undefined;
  const mime = value.slice(5, comma).split(";", 1)[0]?.toLowerCase();
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  return undefined;
};
/** Read a successful provider response within an explicit byte bound, closing its reader. */
export const readResponseBytes = async (
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> => {
  if (!response.ok)
    throw new Error(`provider response status ${String(response.status)}`);
  const claimedLength = response.headers.get("content-length");
  if (claimedLength !== null) {
    const length = Number(claimedLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes)
      throw new Error("provider response exceeds the byte bound");
  }
  if (response.body === null) throw new Error("provider response had no body");
  const reader = new ReadableStreamDefaultReader<Uint8Array>(response.body);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let item = await reader.read();
    while (!item.done) {
      total += item.value.byteLength;
      if (total > maximumBytes)
        throw new Error("provider response exceeds the byte bound");
      chunks.push(item.value);
      item = await reader.read();
    }
  } finally {
    // Closing a rejected stream must not hide its original read/bound failure.
    await reader.cancel().catch((cause: unknown) => {
      reportCatchFailure("provider-response-reader-cancel", cause);
    });
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
/** Host-supplied URL fetching and maximum output bytes for normalization. */
export type MediaProviderOutputOptions = Readonly<{
  /** Fetch a provider image URL through host-owned transport. */
  fetchUrl?: (url: string) => Promise<Response>;
  /** Maximum output bytes, defaulting to MAX_OUTPUT_BYTES. */
  maxBytes?: number;
}>;
/** Normalized bytes and their supported still-image encoding. */
export type MediaImageOutput = Readonly<{
  /** Bounded decoded provider bytes. */
  bytes: Uint8Array;
  /** Detected or explicitly declared image encoding. */
  format: ImageFormat;
}>;
const tryNormalizeBytes = (
  bytes: Uint8Array,
  maximumBytes: number,
  declaredFormat?: ImageFormat,
): MediaImageOutput | undefined => {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes)
    return undefined;
  const format = sniffImageFormat(bytes);
  if (format === undefined) return undefined;
  return { bytes, format: declaredFormat ?? format };
};
const normalizeBytes = (
  bytes: Uint8Array,
  maximumBytes: number,
  declaredFormat?: ImageFormat,
): MediaImageOutput => {
  const output = tryNormalizeBytes(bytes, maximumBytes, declaredFormat);
  if (output === undefined)
    throw new Error("provider image has an unsupported format or size");
  return output;
};

/** Normalize all retained provider envelopes into bounded image bytes. */
export const normalizeMediaProviderOutput = async (
  value: MediaProviderWire,
  options: MediaProviderOutputOptions = {},
): Promise<MediaImageOutput> => {
  const maximumBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("maxBytes must be a positive safe integer");
  const parsed = parseMediaProviderOutput(value);
  if (parsed.kind === "bytes")
    return normalizeBytes(parsed.bytes, maximumBytes);
  if (parsed.kind === "response")
    return normalizeBytes(
      await readResponseBytes(parsed.response, maximumBytes),
      maximumBytes,
    );
  if (parsed.kind === "encoded") {
    if (encodedExceedsBound(parsed.encoded, maximumBytes))
      throw new Error("provider image exceeds the byte bound");
    const bytes = decodeEncoded(parsed.encoded, maximumBytes);
    if (bytes === undefined)
      throw new Error("provider image encoding is invalid");
    return normalizeBytes(
      bytes,
      maximumBytes,
      declaredDataUrlFormat(parsed.encoded),
    );
  }
  for (const entry of parsed.entries) {
    for (const encoded of [entry.base64, entry.data]) {
      if (encoded === undefined) continue;
      const bytes = decodeEncoded(encoded, maximumBytes);
      if (bytes !== undefined) {
        const normalized = tryNormalizeBytes(
          bytes,
          maximumBytes,
          declaredDataUrlFormat(encoded),
        );
        if (normalized !== undefined) return normalized;
      }
    }
    if (entry.url !== undefined) {
      const fetchUrl = options.fetchUrl ?? ((url: string) => fetch(url));
      try {
        const response = await fetchUrl(entry.url);
        return normalizeBytes(
          await readResponseBytes(response, maximumBytes),
          maximumBytes,
        );
      } catch (cause) {
        reportCatchFailure("provider-entry-fetch", cause);
        /* Try the next provider entry. */
      }
    }
  }
  throw new Error("provider returned no valid image bytes");
};

export {
  estimateImageMilliunits,
  estimateImageNeurons,
} from "./cost-estimate.js";
export { neuronsToMilliunits, USD_PER_1K_NEURONS } from "./neurons.js";
export type { ImageParams, ImageReference } from "./cost-estimate.js";

/** Authority-free video quote settings; hydrated host settings are structurally compatible. */
export type MediaVideoQuoteSettings = ReturnType<
  typeof validateMediaGenerationSelection
>;

/** Provider video cost from the sole catalog, in milliunits (1 cent = 1,000). Video-input references are unsupported. */
export function estimateVideoMilliunits(
  settings: MediaVideoQuoteSettings,
): number {
  const checked = validateMediaGenerationSelection({
    ...settings,
    references: settings.references?.map((reference) => ({
      path: reference.path,
      role: reference.role,
    })),
  });
  const model = getMediaModel(checked.model);
  if (model?.video == null || checked.durationSeconds === undefined)
    throw new MediaSettingsError("video cost requires a verified video model");
  const price = model.video.prices.find(
    (candidate) => candidate.resolution === checked.resolution,
  );
  if (price === undefined)
    throw new MediaSettingsError("video price unavailable for this resolution");
  const rate =
    checked.generateAudio === true
      ? price.audioMilliunitsPerSecond
      : price.silentMilliunitsPerSecond;
  return rate * checked.durationSeconds;
}
