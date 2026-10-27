import * as z from "zod";

/** An explicitly requested image encoding; video is outside this contract. */
export const mediaRequestedImageFormatSchema = z.enum({
  /** PNG image encoding. */
  png: "png",
  /** JPEG image encoding. */
  jpeg: "jpeg",
  /** WebP image encoding. */
  webp: "webp",
});

/**
 * Agent-facing selection tier: cheap/fast draft work, the balanced default,
 * premium for art the user will see, and max for the most expensive models.
 * One value per model; never a price.
 */
export const mediaModelTierSchema = z.enum({
  /** Cheap, fast draft model. */
  draft: "draft",
  /** Balanced model selection. */
  balanced: "balanced",
  /** Premium model selection. */
  premium: "premium",
  /** Most expensive model selection. */
  max: "max",
});
/** A model selection tier, independent of billing price. */
export type MediaModelTier = z.output<typeof mediaModelTierSchema>;

/** Media's provider catalog: Workers AI images plus gateway image and video models. */
export const mediaModelInputSchema = z.lazy(() =>
  z
    .strictObject({
      /**
       * Provider input transport. Multipart is the binding's documented
       * ReadableStream body, which AI Gateway cannot carry, so multipart models
       * run without the gateway option (see cloudflare/provider.ts).
       */
      transport: z.enum({
        /** JSON provider input. */
        json: "json",
        /** Multipart provider input. */
        multipart: "multipart",
      }),
      /** Whether this model accepts explicit output dimensions. */
      dimensions: z.enum({
        /** Provider chooses its own dimensions. */
        none: "none",
        /** Provider accepts the requested dimensions. */
        own: "own",
      }),
      /** Maximum accepted dimension in pixels, or null when unbounded by this model. */
      maxDimension: z.number().int().positive().nullable(),
      /** Whether the provider's own page documents `maxDimension`; false for host caps. */
      maxDimensionDocumented: z.boolean(),
      /** Default output width in pixels. */
      defaultWidth: z.number().int().positive(),
      /** Default output height in pixels. */
      defaultHeight: z.number().int().positive(),
      /** Model-specific inference step count. */
      steps: z.enum({
        /** Provider reads the steps field. */
        steps: "steps",
        /** Provider reads the num_steps field. */
        num_steps: "num_steps",
        /** Provider uses fixed inference steps. */
        fixed: "fixed",
      }),
      /** Maximum model steps, or null when the model has no step ceiling. */
      maxSteps: z.number().int().positive().nullable(),
      /** Default inference step count. */
      defaultSteps: z.number().int().nonnegative().nullable(),
      /** Provider multipart reference-field prefix, or null when unsupported. */
      referenceField: z.string().min(1).max(256).nullable(),
      /** Maximum references accepted by this model. */
      maxReferences: z.number().int().nonnegative(),
    })
    .readonly(),
);

/**
 * Schema ceiling for reference lists: the largest per-model limit. Each model's
 * own `maxReferences` / `maxReferenceImages` is enforced after parsing.
 */
export const MAX_REFERENCE_COUNT = 16;

/** Verified Unified AI video identifiers; no inferred family aliases. */
export const mediaVideoModelIdSchema = z.enum({
  /** Seedance 2.0. */
  seedance: "bytedance/seedance-2.0",
  /** Seedance 2.0 Fast. */
  seedanceFast: "bytedance/seedance-2.0-fast",
  /** Seedance 2.0 Mini. */
  seedanceMini: "bytedance/seedance-2.0-mini",
  /** Veo 3.1. */
  veo: "google/veo-3.1",
  /** Veo 3.1 Fast. */
  veoFast: "google/veo-3.1-fast",
  /** MiniMax H3 Max. */
  minimaxH3Max: "minimax/h3-max",
});
/** Verified video model identifier. */
export type MediaVideoModelId = z.output<typeof mediaVideoModelIdSchema>;
/** Provider resolution selectors, refined against the selected catalog entry. */
export const mediaVideoResolutionSchema = z.enum({
  /** 480p. */
  p480: "480p",
  /** 720p. */
  p720: "720p",
  /** 768p, admitted only by MiniMax H3 Max. */
  p768: "768p",
  /** 1080p. */
  p1080: "1080p",
  /** 4k, admitted only by Seedance 2.0. */
  p4k: "4k",
});
/** A video resolution selector. */
export type MediaVideoResolution = z.output<typeof mediaVideoResolutionSchema>;
/** Documented video aspect selectors, refined per model. */
export const mediaVideoAspectRatioSchema = z.enum({
  /** Landscape widescreen. */
  wide: "16:9",
  /** Landscape standard. */
  landscape: "4:3",
  /** Square. */
  square: "1:1",
  /** Portrait standard. */
  portrait: "3:4",
  /** Portrait widescreen. */
  tall: "9:16",
  /** Landscape ultrawide. */
  ultrawide: "21:9",
  /** Portrait ultrawide. */
  ultratall: "9:21",
});
/** A video aspect selector. */
export type MediaVideoAspectRatio = z.output<
  typeof mediaVideoAspectRatioSchema
>;
/** Explicit reference meaning; frame mode and reference mode are exclusive. */
export const mediaVideoReferenceRoleSchema = z.enum({
  /** First frame; required when a last frame is supplied. */
  first: "first-frame",
  /** Last frame, supported by Seedance only (`last_frame_image`). */
  last: "last-frame",
  /** One image in Seedance reference-image mode. */
  reference: "reference",
});
/** The role of a selected reference image in a video request. */
export type MediaVideoReferenceRole = z.output<
  typeof mediaVideoReferenceRoleSchema
>;

/** One nominal size used to select provider resolution and aspect. */
export const mediaVideoFormatSchema = z.lazy(() =>
  z
    .strictObject({
      /** Provider resolution. */
      resolution: mediaVideoResolutionSchema,
      /** Requested aspect; Seedance may derive actual aspect from its first image. */
      aspectRatio: mediaVideoAspectRatioSchema,
      /** Nominal width; actual MP4 dimensions are not decoded. */
      width: z.number().int().positive(),
      /** Nominal height; actual MP4 dimensions are not decoded. */
      height: z.number().int().positive(),
    })
    .readonly(),
);
/** One immutable nominal video format. */
export type MediaVideoFormat = z.output<typeof mediaVideoFormatSchema>;

/** Verified video parameters and provider costs, checked 2026-10-11. */
export const mediaVideoSchema = z.lazy(() =>
  z
    .strictObject({
      /** Minimum duration, for callers displaying bounds. */
      minSeconds: z.number().int().positive(),
      /** Maximum duration; durations still owns membership. */
      maxSeconds: z.number().int().positive(),
      /** Default duration. */
      defaultSeconds: z.number().int().positive(),
      /** Exact accepted whole-second durations. */
      durations: z.array(z.number().int().positive()).readonly(),
      /** Verified provider input grammar. */
      provider: z.enum({
        /** Seedance integer duration and data-URI image fields. */
        seedance: "seedance",
        /** Veo duration string and base64 image_input. */
        veo: "veo",
        /** MiniMax multimodal `content[]` array and uppercase resolution. */
        minimax: "minimax",
      }),
      /** Supported resolution/aspect combinations and their nominal selectors. */
      formats: z.array(mediaVideoFormatSchema).readonly(),
      /** Resolution selected when omitted. */
      defaultResolution: mediaVideoResolutionSchema,
      /** Aspect selected when omitted. */
      defaultAspectRatio: mediaVideoAspectRatioSchema,
      /** Whether the model documents a `generate_audio` choice. */
      supportsAudio: z.boolean(),
      /** Audio default, or null when not documented and left to the provider. */
      defaultGenerateAudio: z.boolean().nullable(),
      /** Frame or reference roles this provider accepts. */
      referenceRoles: z.array(mediaVideoReferenceRoleSchema).readonly(),
      /** Reference-image mode count; first/last frame mode has its own grammar. */
      maxReferenceImages: z.number().int().nonnegative(),
      /** Resolutions supporting reference-image mode. */
      referenceResolutions: z.array(mediaVideoResolutionSchema).readonly(),
      /** Non-video-input provider cost; 1 USD = 100,000 milliunits. */
      prices: z
        .array(
          z
            .strictObject({
              /** Billed output resolution. */
              resolution: mediaVideoResolutionSchema,
              /** Provider milliunits per output second without audio. */
              silentMilliunitsPerSecond: z.number().int().positive(),
              /** Provider milliunits per output second with audio. */
              audioMilliunitsPerSecond: z.number().int().positive(),
            })
            .readonly(),
        )
        .readonly(),
    })
    .readonly(),
);
/** Immutable video capability and price metadata. */
export type MediaVideoModel = z.output<typeof mediaVideoSchema>;

/**
 * Structural ceiling for any prompt on the wire. Each model's own
 * `maxPromptLength` is the real bound; no model may exceed this ceiling.
 */
export const MAX_MEDIA_PROMPT_LENGTH = 32_000;
/** Prompt cap kept for models whose provider documents no prompt limit. */
const UNDOCUMENTED_PROMPT_LENGTH = 2_048;

/** Public wire grammar for a catalog entry returned by the Media owner. */
export const mediaModelSchema = z
  .strictObject({
    /** Provider model identifier. */
    id: z.string().min(1).max(256),
    /** Customer-visible model label. */
    label: z.string().min(1).max(512),
    /** Outcome or model-kind discriminant. */
    kind: z.enum({
      /** Still-image generation. */
      image: "image",
      /** Video generation. */
      video: "video",
    }),
    /** Model selection tier, independent of price. */
    tier: mediaModelTierSchema,
    /** Verified provider encodings; an empty list refuses pinned formats. */
    outputFormats: z.array(mediaRequestedImageFormatSchema).max(3).readonly(),
    /**
     * Maximum prompt length in characters for this model: the provider's
     * documented limit, or the retained 2,048 host cap where none is documented.
     */
    maxPromptLength: z.number().int().positive().max(MAX_MEDIA_PROMPT_LENGTH),
    /** Model-native input options and reference limits. */
    input: mediaModelInputSchema,
    /**
     * Image output sizes or nominal video selectors, as `WIDTHxHEIGHT`; null means
     * any size within the input bounds.
     */
    sizes: z
      .array(z.string().regex(/^\d+x\d+$/u))
      .readonly()
      .nullable(),
    /** Video length constraints, or null for a still-image model. */
    video: mediaVideoSchema.nullable(),
  })
  .readonly();

/** Model-specific dimensions, steps, transport and reference limits. */
export type MediaModelInput = z.output<typeof mediaModelInputSchema>;
/** One immutable provider catalog entry. */
export type MediaModel = z.output<typeof mediaModelSchema>;

const freezeModel = (
  model: Omit<MediaModel, "kind" | "sizes" | "video" | "outputFormats"> &
    Partial<Pick<MediaModel, "kind" | "sizes" | "video" | "outputFormats">>,
): MediaModel =>
  Object.freeze({
    kind: "image",
    sizes: null,
    video: null,
    outputFormats: Object.freeze([]),
    ...model,
    input: Object.freeze(model.input),
  });

const videoShortEdges = {
  "480p": 480,
  "720p": 720,
  "768p": 768,
  "1080p": 1080,
  "4k": 2160,
} satisfies Record<MediaVideoResolution, number>;
const videoAspects = {
  "16:9": [16, 9],
  "4:3": [4, 3],
  "1:1": [1, 1],
  "3:4": [3, 4],
  "9:16": [9, 16],
  "21:9": [21, 9],
  "9:21": [9, 21],
} satisfies Record<MediaVideoAspectRatio, readonly [number, number]>;

function videoModel(
  id: MediaVideoModelId,
  label: string,
  tier: MediaModelTier,
  provider: MediaVideoModel["provider"],
  rates: readonly (readonly [MediaVideoResolution, number, number])[],
): MediaModel {
  const seedance = provider === "seedance";
  const aspects = seedance
    ? mediaVideoAspectRatioSchema.options
    : [
        mediaVideoAspectRatioSchema.enum.wide,
        mediaVideoAspectRatioSchema.enum.tall,
        mediaVideoAspectRatioSchema.enum.square,
      ];
  // Nominal dimensions select resolution/aspect; upstream does not accept pixels.
  // Round the long edge to even pixels, retaining the existing 854x480 selector.
  const formats = Object.freeze(
    rates.flatMap(([resolution]) =>
      aspects.map((aspectRatio): MediaVideoFormat => {
        const [w, h] = videoAspects[aspectRatio];
        const edge = videoShortEdges[resolution];
        const shorter = Math.min(w, h);
        return Object.freeze({
          resolution,
          aspectRatio,
          width: Math.ceil((edge * w) / shorter / 2) * 2,
          height: Math.ceil((edge * h) / shorter / 2) * 2,
        });
      }),
    ),
  );
  const durations = Object.freeze(
    seedance ? [4, 5, 6, 7, 8, 9, 10, 11, 12] : [4, 6, 8],
  );
  const video: MediaVideoModel = Object.freeze({
    minSeconds: 4,
    maxSeconds: seedance ? 12 : 8,
    defaultSeconds: seedance ? 5 : 6,
    durations,
    provider,
    formats,
    defaultResolution: "720p",
    defaultAspectRatio: "16:9",
    // Seedance documents `generate_audio` without a default; Veo documents
    // `generate_audio` with default true.
    // https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/
    // https://developers.cloudflare.com/ai/models/google/veo-3.1/
    supportsAudio: true,
    defaultGenerateAudio: seedance ? null : true,
    referenceRoles: Object.freeze(
      seedance
        ? mediaVideoReferenceRoleSchema.options
        : [mediaVideoReferenceRoleSchema.enum.first],
    ),
    maxReferenceImages: seedance ? 4 : 0,
    referenceResolutions: Object.freeze(
      seedance
        ? rates
            .map(([resolution]) => resolution)
            .filter((resolution) => resolution !== "1080p")
        : [],
    ),
    prices: Object.freeze(
      rates.map(
        ([resolution, silentMilliunitsPerSecond, audioMilliunitsPerSecond]) =>
          Object.freeze({
            resolution,
            silentMilliunitsPerSecond,
            audioMilliunitsPerSecond,
          }),
      ),
    ),
  });
  return freezeModel({
    id,
    label,
    tier,
    // Seedance: the provider's own 2,000-character bound (retained from the
    // earlier video contract).
    // Veo documents no character limit; keep the retained 2,048 host cap.
    maxPromptLength: seedance ? 2_000 : UNDOCUMENTED_PROMPT_LENGTH,
    kind: "video",
    video,
    sizes: Object.freeze(
      formats.map(({ width, height }) => `${String(width)}x${String(height)}`),
    ),
    input: {
      transport: "json",
      dimensions: "own",
      maxDimension: Math.max(
        ...formats.map(({ width, height }) => Math.max(width, height)),
      ),
      maxDimensionDocumented: false,
      defaultWidth: 1280,
      defaultHeight: 720,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: null,
      referenceField: seedance ? "image" : "image_input",
      maxReferences: seedance ? 4 : 1,
    },
  });
}

// MiniMax H3 Max diverges too far from `videoModel()`'s shared seedance/veo
// shape to reuse it: its wire resolution literals are uppercase ("480P"),
// its ratio grammar admits no "9:21" selector, and its request body is a
// multimodal `content[]` array dispatched by `media-generation.ts`, not a
// flat prompt/image body. https://developers.cloudflare.com/ai/models/minimax/h3-max/
function minimaxVideoModel(): MediaModel {
  const resolutions = [
    "480p",
    "768p",
  ] as const satisfies readonly MediaVideoResolution[];
  const aspects = [
    mediaVideoAspectRatioSchema.enum.wide,
    mediaVideoAspectRatioSchema.enum.landscape,
    mediaVideoAspectRatioSchema.enum.square,
    mediaVideoAspectRatioSchema.enum.portrait,
    mediaVideoAspectRatioSchema.enum.tall,
    mediaVideoAspectRatioSchema.enum.ultrawide,
  ];
  const formats = Object.freeze(
    resolutions.flatMap((resolution) =>
      aspects.map((aspectRatio): MediaVideoFormat => {
        const [w, h] = videoAspects[aspectRatio];
        const edge = videoShortEdges[resolution];
        const shorter = Math.min(w, h);
        return Object.freeze({
          resolution,
          aspectRatio,
          width: Math.ceil((edge * w) / shorter / 2) * 2,
          height: Math.ceil((edge * h) / shorter / 2) * 2,
        });
      }),
    ),
  );
  const defaultResolution = mediaVideoResolutionSchema.enum.p768;
  const defaultAspectRatio = mediaVideoAspectRatioSchema.enum.wide;
  const defaultFormat = formats.find(
    (format) =>
      format.resolution === defaultResolution &&
      format.aspectRatio === defaultAspectRatio,
  );
  if (defaultFormat === undefined)
    throw new Error("minimax/h3-max is missing its default format");
  // Integers 5 through 15 inclusive; the documented bound has no gaps.
  const durations = Object.freeze(
    Array.from({ length: 11 }, (_, index) => index + 5),
  );
  const video: MediaVideoModel = Object.freeze({
    minSeconds: 5,
    maxSeconds: 15,
    defaultSeconds: 5,
    durations,
    provider: "minimax",
    formats,
    defaultResolution,
    defaultAspectRatio,
    // Not merely undocumented: the schema has no audio field at all, so the
    // dispatcher refuses an explicit generateAudio choice outright.
    defaultGenerateAudio: null,
    supportsAudio: false,
    // The vendor page documents `first_frame` and `reference_image` roles only;
    // it names no last frame.
    referenceRoles: Object.freeze([
      mediaVideoReferenceRoleSchema.enum.first,
      mediaVideoReferenceRoleSchema.enum.reference,
    ]),
    // The vendor page documents up to nine; this stays at the conservative
    // verified value of four until the gateway schema is confirmed.
    maxReferenceImages: 4,
    referenceResolutions: Object.freeze(resolutions),
    prices: Object.freeze([
      {
        resolution: mediaVideoResolutionSchema.enum.p480,
        // No documented audio surcharge; one rate serves both selectors.
        silentMilliunitsPerSecond: 5_000,
        audioMilliunitsPerSecond: 5_000,
      },
      {
        resolution: mediaVideoResolutionSchema.enum.p768,
        silentMilliunitsPerSecond: 8_000,
        audioMilliunitsPerSecond: 8_000,
      },
    ]),
  });
  return freezeModel({
    id: mediaVideoModelIdSchema.enum.minimaxH3Max,
    label: "MiniMax H3 Max",
    tier: "balanced",
    // 7,000 characters per the vendor page cited above.
    maxPromptLength: 7_000,
    kind: "video",
    video,
    sizes: Object.freeze(
      formats.map(({ width, height }) => `${String(width)}x${String(height)}`),
    ),
    input: {
      transport: "json",
      dimensions: "own",
      maxDimension: Math.max(
        ...formats.map(({ width, height }) => Math.max(width, height)),
      ),
      maxDimensionDocumented: false,
      defaultWidth: defaultFormat.width,
      defaultHeight: defaultFormat.height,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: null,
      // Inert for this gateway model (media-generation.ts builds its body
      // directly); recorded for the same documentation parity as Seedance/Veo.
      referenceField: "image_url",
      maxReferences: 4,
    },
  });
}

const models: readonly MediaModel[] = Object.freeze([
  freezeModel({
    id: "@cf/black-forest-labs/flux-1-schnell",
    // 2,048 characters: input schema maxLength at developers.cloudflare.com/workers-ai/models/flux-1-schnell/.
    maxPromptLength: 2_048,
    outputFormats: Object.freeze(["jpeg"]),
    tier: "draft",
    label: "Flux 1 Schnell — cheap/fast sketches",
    input: {
      transport: "json",
      dimensions: "none",
      maxDimension: null,
      maxDimensionDocumented: false,
      defaultWidth: 1024,
      defaultHeight: 768,
      steps: "steps",
      maxSteps: 8,
      defaultSteps: 4,
      referenceField: null,
      maxReferences: 0,
    },
  }),
  freezeModel({
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    // Workers AI documents no prompt maxLength for this model; keep the 2,048 host cap.
    maxPromptLength: UNDOCUMENTED_PROMPT_LENGTH,
    tier: "balanced",
    label: "Flux 2 Klein 4b — balanced default",
    input: {
      transport: "multipart",
      dimensions: "own",
      maxDimension: 1920,
      maxDimensionDocumented: false,
      defaultWidth: 1024,
      defaultHeight: 768,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: 4,
      referenceField: "input_image_",
      maxReferences: 4,
    },
  }),
  freezeModel({
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    // Workers AI documents no prompt maxLength for this model; keep the 2,048 host cap.
    maxPromptLength: UNDOCUMENTED_PROMPT_LENGTH,
    tier: "premium",
    label: "Flux 2 Klein 9b — higher quality flux-2",
    input: {
      transport: "multipart",
      dimensions: "own",
      maxDimension: 1920,
      maxDimensionDocumented: false,
      defaultWidth: 1024,
      defaultHeight: 768,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: 4,
      referenceField: "input_image_",
      maxReferences: 4,
    },
  }),
  freezeModel({
    id: "@cf/black-forest-labs/flux-2-dev",
    // Workers AI documents no prompt maxLength for this model; keep the 2,048 host cap.
    maxPromptLength: UNDOCUMENTED_PROMPT_LENGTH,
    tier: "max",
    label: "Flux 2 Dev — best detailed quality, expensive",
    input: {
      transport: "multipart",
      dimensions: "own",
      maxDimension: 1920,
      maxDimensionDocumented: false,
      defaultWidth: 1024,
      defaultHeight: 768,
      steps: "steps",
      maxSteps: null,
      defaultSteps: 20,
      referenceField: "input_image_",
      maxReferences: 4,
    },
  }),
  freezeModel({
    id: "@cf/leonardo/lucid-origin",
    // Workers AI documents no prompt maxLength for this model; keep the 2,048 host cap.
    maxPromptLength: UNDOCUMENTED_PROMPT_LENGTH,
    tier: "premium",
    label: "Leonardo Lucid Origin — premium prompt adherence",
    input: {
      transport: "json",
      dimensions: "own",
      // https://developers.cloudflare.com/workers-ai/models/lucid-origin/ (width/height maximum)
      maxDimension: 2500,
      maxDimensionDocumented: true,
      defaultWidth: 1120,
      defaultHeight: 1120,
      steps: "num_steps",
      maxSteps: 40,
      defaultSteps: null,
      referenceField: null,
      maxReferences: 0,
    },
  }),
  freezeModel({
    id: "@cf/leonardo/phoenix-1.0",
    // Workers AI documents no prompt maxLength for this model; keep the 2,048 host cap.
    maxPromptLength: UNDOCUMENTED_PROMPT_LENGTH,
    tier: "balanced",
    label: "Leonardo Phoenix 1.0 — best prompt adherence",
    input: {
      transport: "json",
      dimensions: "own",
      // https://developers.cloudflare.com/workers-ai/models/phoenix-1.0/ (width/height range)
      maxDimension: 2048,
      maxDimensionDocumented: true,
      defaultWidth: 1024,
      defaultHeight: 1024,
      steps: "num_steps",
      maxSteps: 50,
      defaultSteps: 25,
      referenceField: null,
      maxReferences: 0,
    },
  }),
  // Third-party models run through the AI Gateway (Unified Billing): OpenAI's
  // image model and ByteDance's video model return a result URL, not bytes.
  freezeModel({
    id: "openai/gpt-image-2",
    // 32,000 characters: OpenAI's Images API reference gives GPT image models a 32000-character prompt limit.
    maxPromptLength: 32_000,
    outputFormats: Object.freeze(["png", "jpeg", "webp"]),
    tier: "premium",
    label: "GPT Image 2 — strong text and layout, premium",
    sizes: Object.freeze(["1024x1024", "1024x1536", "1536x1024"]),
    input: {
      transport: "json",
      dimensions: "own",
      maxDimension: 1536,
      maxDimensionDocumented: false,
      defaultWidth: 1024,
      defaultHeight: 1024,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: null,
      // Cloudflare documents `images[]` (base64 strings or data URIs, 1-16
      // entries, routed to OpenAI's /v1/images/edits) for this exact model:
      // https://developers.cloudflare.com/ai/models/openai/gpt-image-2/
      // OpenAI's own page shows multipart `image[]` without stating a cap, so
      // 16 is Cloudflare's published schema limit, the route Prints calls.
      referenceField: "images",
      maxReferences: 16,
    },
  }),
  videoModel(
    mediaVideoModelIdSchema.enum.seedance,
    "Seedance 2.0",
    "balanced",
    "seedance",
    [
      ["480p", 7_000, 7_000],
      ["720p", 15_000, 15_000],
      ["1080p", 37_000, 37_000],
      ["4k", 78_000, 78_000],
    ],
  ),
  videoModel(
    mediaVideoModelIdSchema.enum.seedanceFast,
    "Seedance 2.0 Fast",
    "draft",
    "seedance",
    [
      ["480p", 6_000, 6_000],
      ["720p", 12_000, 12_000],
    ],
  ),
  videoModel(
    mediaVideoModelIdSchema.enum.seedanceMini,
    "Seedance 2.0 Mini",
    "draft",
    "seedance",
    [
      ["480p", 4_000, 4_000],
      ["720p", 9_000, 9_000],
    ],
  ),
  videoModel(mediaVideoModelIdSchema.enum.veo, "Veo 3.1", "premium", "veo", [
    ["720p", 20_000, 40_000],
    ["1080p", 20_000, 40_000],
  ]),
  videoModel(
    mediaVideoModelIdSchema.enum.veoFast,
    "Veo 3.1 Fast",
    "balanced",
    "veo",
    [
      ["720p", 8_000, 10_000],
      ["1080p", 10_000, 12_000],
    ],
  ),
  minimaxVideoModel(),
]);

/** The immutable image and video model catalog. */
export const mediaModels: readonly MediaModel[] = models;
/** List all image and video models in catalog order. */
export const listMediaModels = (): readonly MediaModel[] => mediaModels;
/** Find a model by provider identifier, returning undefined when it is absent. */
export const getMediaModel = (id: string): MediaModel | undefined =>
  mediaModels.find((model) => model.id === id);

/** Invalid generation settings or unsupported model parameters. */
export class MediaSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaSettingsError";
  }
}
