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

/** Media's provider catalog: Workers AI images plus gateway image, video and audio models. */
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
      /** Long edge, in pixels, an image model's references are fitted to; null for video models. */
      referenceDimension: z.number().int().positive().nullable(),
      /** Encoding of a fitted reference: PNG is lossless, WebP bounds the request body. */
      referenceFormat: z.enum({
        /** Lossless PNG. */
        png: "png",
        /** Lossy WebP. */
        webp: "webp",
      }),
    })
    .readonly(),
);

/**
 * Schema ceiling for reference lists: the largest per-model limit. Each model's
 * own `maxReferences` / `maxReferenceImages` is enforced after parsing.
 */
export const MAX_REFERENCE_COUNT = 30;

/** Verified Unified AI video identifiers; no inferred family aliases. */
export const mediaVideoModelIdSchema = z.enum({
  /** Seedance 2.5. */
  seedance25: "bytedance/seedance-2.5",
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
      /**
       * Audio clips accepted as `reference_audios`, or null when the model has
       * no audio references. Declared by the provider's input schema, never
       * inferred from the family.
       */
      audioReferences: z
        .strictObject({
          /** Most clips in one request. */
          max: z.number().int().positive(),
          /** Longest total duration of all clips, in seconds. */
          totalSeconds: z.number().int().positive(),
        })
        .readonly()
        .nullable(),
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
 * Verified ElevenLabs model identifiers on Cloudflare's Unified Billing, from
 * the model pages under https://developers.cloudflare.com/ai/models/elevenlabs/
 * (checked 2026-11-13). Cloudflare offers no sound-effects model. Eleven Flash
 * v2.5 and Turbo v2.5 are listed there but a live Unified Billing call to Flash
 * answered 403 code 2047 ("not available via unified billing. Please use
 * BYOK"), so they are not offered. Multilingual v2 is the default voice model.
 */
export const mediaAudioModelIdSchema = z.enum({
  /** Eleven Multilingual v2 text to speech. */
  multilingual: "elevenlabs/eleven-multilingual-v2",
  /** Eleven v3 expressive text to speech. */
  v3: "elevenlabs/eleven-v3",
  /** Eleven Music v2. */
  music: "elevenlabs/music-v2",
});
/** Verified audio model identifier. */
export type MediaAudioModelId = z.output<typeof mediaAudioModelIdSchema>;

/** One premade voice a speech model may speak with. */
export const mediaAudioVoiceSchema = z.lazy(() =>
  z
    .strictObject({
      /** ElevenLabs voice identifier, exactly as Cloudflare's docs list it. */
      id: z.string().min(1).max(64),
      /** Customer-visible voice label. */
      label: z.string().min(1).max(128),
    })
    .readonly(),
);
/** One premade speech voice. */
export type MediaAudioVoice = z.output<typeof mediaAudioVoiceSchema>;

/** Verified audio parameters and provider cost, checked 2026-11-13. */
export const mediaAudioSchema = z.lazy(() =>
  z
    .strictObject({
      /** Provider translation family. */
      provider: z.literal("elevenlabs"),
      /** Speech reads the prompt aloud; music composes from it. */
      mode: z.enum({
        /** Text to speech: the prompt is the spoken text. */
        speech: "speech",
        /** Music: the prompt describes the track. */
        music: "music",
      }),
      /** Premade voices; empty for music. */
      voices: z.array(mediaAudioVoiceSchema).readonly(),
      /** Voice used when none is chosen; null for music. */
      defaultVoiceId: z.string().min(1).max(64).nullable(),
      /** Music length bounds in whole seconds; null for speech. */
      seconds: z
        .strictObject({
          /** Shortest track. */
          min: z.number().int().positive(),
          /** Longest track. */
          max: z.number().int().positive(),
          /** Length when omitted. */
          default: z.number().int().positive(),
        })
        .readonly()
        .nullable(),
      /** Provider milliunits per billed unit; 1 USD = 100,000 milliunits. */
      milliunitsPerUnit: z.number().int().positive(),
    })
    .readonly(),
);
/** Immutable audio capability and price metadata. */
export type MediaAudioModel = z.output<typeof mediaAudioSchema>;

/** Characters one speech billing block covers. */
export const AUDIO_CHARACTER_BLOCK = 100;

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
      /** Speech or music generation. */
      audio: "audio",
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
    /** Speech or music constraints, or null for an image or video model. */
    audio: mediaAudioSchema.nullable(),
  })
  .readonly();

/** Model-specific dimensions, steps, transport and reference limits. */
export type MediaModelInput = z.output<typeof mediaModelInputSchema>;
/** One immutable provider catalog entry. */
export type MediaModel = z.output<typeof mediaModelSchema>;

const freezeModel = (
  model: Omit<
    MediaModel,
    "kind" | "sizes" | "video" | "audio" | "outputFormats"
  > &
    Partial<
      Pick<MediaModel, "kind" | "sizes" | "video" | "audio" | "outputFormats">
    >,
): MediaModel =>
  Object.freeze({
    kind: "image",
    sizes: null,
    video: null,
    audio: null,
    outputFormats: Object.freeze([]),
    ...model,
    input: Object.freeze(model.input),
  });

/**
 * GPT Image 2's `size` is `auto` or any WIDTHxHEIGHT with each edge at most
 * 3840, both edges multiples of 16, an aspect ratio between 1:3 and 3:1 and a
 * total of 655,360 to 8,294,400 pixels (no enum).
 * https://developers.cloudflare.com/ai/models/openai/gpt-image-2/
 * https://developers.cloudflare.com/ai/models/openai/gpt-image-2/schema-input.json
 * The catalog lists each common ratio at a standard size (about one megapixel;
 * the three sizes Prints always offered stay as they were) and at the largest
 * size the limits allow, so every entry is exact in ratio and in bounds.
 */
const GPT_IMAGE_MAX_EDGE = 3_840;
/** Largest pixel count the documented size grammar admits. */
const GPT_IMAGE_MAX_PIXELS = 8_294_400;
const COMMON_IMAGE_RATIOS = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [21, 9],
] as const;
const gptImageSizes: readonly string[] = (() => {
  const keep = new Set(["1024x1024", "1024x1536", "1536x1024"]);
  const standard: string[] = [];
  const largest: string[] = [];
  for (const [across, down] of COMMON_IMAGE_RATIOS) {
    const divisor = ((a: number, b: number): number => {
      let x = a;
      let y = b;
      while (y !== 0) [x, y] = [y, x % y];
      return x;
    })(across, down);
    const unitW = (16 * across) / divisor;
    const unitH = (16 * down) / divisor;
    const unitArea = unitW * unitH;
    const at = (k: number) => `${String(unitW * k)}x${String(unitH * k)}`;
    const fit = Math.round(Math.sqrt(1_048_576 / unitArea));
    const known = [...keep].find((size) => {
      const [w, h] = size.split("x").map(Number);
      return (w ?? 0) * down === (h ?? 0) * across;
    });
    standard.push(known ?? at(fit));
    largest.push(
      at(
        Math.floor(
          Math.min(
            GPT_IMAGE_MAX_EDGE / Math.max(unitW, unitH),
            Math.sqrt(GPT_IMAGE_MAX_PIXELS / unitArea),
          ),
        ),
      ),
    );
  }
  return Object.freeze([...standard, ...largest]);
})();

/** The common ratios as exact 16-aligned sizes of about `area` pixels. */
const commonRatioSizes = (area: number): readonly string[] =>
  Object.freeze(
    COMMON_IMAGE_RATIOS.map(([across, down]) => {
      let x: number = across;
      let y: number = down;
      while (y !== 0) [x, y] = [y, x % y];
      const unitW = (16 * across) / x;
      const unitH = (16 * down) / x;
      const steps = Math.round(Math.sqrt(area / (unitW * unitH)));
      return `${String(unitW * steps)}x${String(unitH * steps)}`;
    }),
  );

/**
 * Seedream 5 Pro takes `size` as a string: "1K", "2K" or an explicit pixel
 * size (the page's examples are "1K" and "1536x864"). It documents no bounds,
 * so each common ratio is listed as an exact explicit size at the scale of its
 * own 1536x864 example (about 1.3 megapixels), where 16:9 is that example.
 * https://developers.cloudflare.com/ai/models/bytedance/seedream-5-pro/
 * https://developers.cloudflare.com/ai/models/bytedance/seedream-5-pro/schema-input.json
 */
const seedreamSizes = commonRatioSizes(1536 * 864);

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

/**
 * Seedance 2.5's own bounds, from its Cloudflare input schema (duration 4-30,
 * 480p/720p, `reference_images` up to 30, a 25,000-character prompt, no 9:21).
 * https://developers.cloudflare.com/ai/models/bytedance/seedance-2.5/
 * Prices are Cloudflare dashboard prices, supplied by the owner 2026-11-13;
 * the public model page lists none. Only the non-video-input rates apply, as
 * video-input references are unsupported.
 * `reference_audios` takes at most 10 clips totalling 30 seconds
 * (https://developers.cloudflare.com/ai/models/bytedance/seedance-2.5/schema-input.json).
 */
const seedance25 = {
  maxSeconds: 30,
  maxReferenceImages: 30,
  audioReferences: { max: 10, totalSeconds: 30 },
  maxPromptLength: 25_000,
  resolutions: ["480p", "720p"],
  aspects: mediaVideoAspectRatioSchema.options.filter(
    (aspectRatio) => aspectRatio !== mediaVideoAspectRatioSchema.enum.ultratall,
  ),
} as const;

function videoModel(
  id: MediaVideoModelId,
  label: string,
  tier: MediaModelTier,
  provider: MediaVideoModel["provider"],
  rates: readonly (readonly [MediaVideoResolution, number, number])[],
  bounds?: typeof seedance25,
): MediaModel {
  const seedance = provider === "seedance";
  const resolutions: readonly MediaVideoResolution[] =
    bounds?.resolutions ?? rates.map(([resolution]) => resolution);
  const maxSeconds = bounds?.maxSeconds ?? (seedance ? 12 : 8);
  const maxReferenceImages = bounds?.maxReferenceImages ?? (seedance ? 4 : 0);
  const aspects = bounds
    ? bounds.aspects
    : seedance
      ? mediaVideoAspectRatioSchema.options
      : [
          mediaVideoAspectRatioSchema.enum.wide,
          mediaVideoAspectRatioSchema.enum.tall,
          mediaVideoAspectRatioSchema.enum.square,
        ];
  // Nominal dimensions select resolution/aspect; upstream does not accept pixels.
  // Round the long edge to even pixels, retaining the existing 854x480 selector.
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
  const durations = Object.freeze(
    seedance
      ? Array.from({ length: maxSeconds - 3 }, (_, index) => index + 4)
      : [4, 6, 8],
  );
  const video: MediaVideoModel = Object.freeze({
    minSeconds: 4,
    maxSeconds,
    defaultSeconds: seedance ? 5 : 6,
    durations,
    provider,
    formats,
    defaultResolution: "720p",
    defaultAspectRatio: "16:9",
    // Veo documents `generate_audio` with default true. Seedance documents no
    // default; Botanical chooses On (priced the same as silent) so a prompt's
    // AUDIO and dialogue lines take effect without touching the control.
    // https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/
    // https://developers.cloudflare.com/ai/models/google/veo-3.1/
    supportsAudio: true,
    defaultGenerateAudio: true,
    referenceRoles: Object.freeze(
      seedance
        ? mediaVideoReferenceRoleSchema.options
        : [mediaVideoReferenceRoleSchema.enum.first],
    ),
    maxReferenceImages,
    audioReferences:
      bounds === undefined
        ? null
        : Object.freeze({ ...bounds.audioReferences }),
    referenceResolutions: Object.freeze(
      seedance
        ? resolutions.filter((resolution) => resolution !== "1080p")
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
    // Seedance 2.0, Fast and Mini: 10,000 characters, from each Cloudflare
    // input schema (the earlier 2,000 rejected real ~2,500-character
    // production prompts). https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/
    // Veo documents no character limit; keep the retained 2,048 host cap.
    maxPromptLength:
      bounds?.maxPromptLength ??
      (seedance ? 10_000 : UNDOCUMENTED_PROMPT_LENGTH),
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
      maxReferences: seedance ? maxReferenceImages : 1,
      referenceDimension: null,
      referenceFormat: "png",
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
    audioReferences: null,
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
      referenceDimension: null,
      referenceFormat: "png",
    },
  });
}

/**
 * The one voice Cloudflare's ElevenLabs pages list: every `voice_id` example
 * and request sample on the TTS model pages uses it, and there is no voice
 * listing endpoint on Cloudflare. More voices are added only from a page that
 * lists them.
 * https://developers.cloudflare.com/ai/models/elevenlabs/eleven-v3/
 */
const premadeVoices: readonly MediaAudioVoice[] = Object.freeze([
  Object.freeze({ id: "JBFqnCBsd6RMkjVDRZzb", label: "Default voice" }),
]);

/**
 * An ElevenLabs speech model. Text is at most 10,000 characters and a
 * `voice_id` is required (each model's `schema-input.json`); the rate is the
 * per-character price on its Cloudflare page, 1 USD = 100,000 milliunits.
 * https://developers.cloudflare.com/ai/models/elevenlabs/eleven-v3/
 * https://developers.cloudflare.com/ai/models/elevenlabs/eleven-multilingual-v2/
 */
function speechModel(
  id: MediaAudioModelId,
  label: string,
  tier: MediaModelTier,
  milliunitsPerCharacter: number,
): MediaModel {
  return audioModel(id, label, tier, 10_000, {
    provider: "elevenlabs",
    mode: "speech",
    voices: premadeVoices,
    defaultVoiceId: premadeVoices[0]?.id ?? null,
    seconds: null,
    milliunitsPerUnit: milliunitsPerCharacter,
  });
}

/**
 * Eleven Music v2: `music_length_ms` runs 3,000 through 600,000 and the page
 * lists $0.0025 per output second (250 milliunits). The prompt has no
 * documented limit, so the retained 2,048 host cap applies. The model is run
 * with a length always set, so the quote is the length asked for.
 * https://developers.cloudflare.com/ai/models/elevenlabs/music-v2/
 */
function musicModel(): MediaModel {
  return audioModel(
    mediaAudioModelIdSchema.enum.music,
    "Eleven Music v2",
    "premium",
    UNDOCUMENTED_PROMPT_LENGTH,
    {
      provider: "elevenlabs",
      mode: "music",
      voices: Object.freeze([]),
      defaultVoiceId: null,
      seconds: Object.freeze({ min: 3, max: 600, default: 30 }),
      milliunitsPerUnit: 250,
    },
  );
}

function audioModel(
  id: MediaAudioModelId,
  label: string,
  tier: MediaModelTier,
  maxPromptLength: number,
  audio: MediaAudioModel,
): MediaModel {
  return freezeModel({
    id,
    label,
    tier,
    maxPromptLength,
    kind: "audio",
    audio: Object.freeze(audio),
    input: {
      transport: "json",
      dimensions: "none",
      maxDimension: null,
      maxDimensionDocumented: false,
      // Audio has no dimensions; the shared wire grammar still requires a
      // positive default, and nothing reads it for an audio model.
      defaultWidth: 1,
      defaultHeight: 1,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: null,
      referenceField: null,
      maxReferences: 0,
      referenceDimension: null,
      referenceFormat: "png",
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
      // No documented reference size for this model; the retained 512 px fit.
      referenceDimension: 512,
      referenceFormat: "png",
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
      // No documented reference size for this model; the retained 512 px fit.
      referenceDimension: 512,
      referenceFormat: "png",
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
      // No documented reference size for this model; the retained 512 px fit.
      referenceDimension: 512,
      referenceFormat: "png",
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
      // No documented reference size for this model; the retained 512 px fit.
      referenceDimension: 512,
      referenceFormat: "png",
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
      // No documented reference size for this model; the retained 512 px fit.
      referenceDimension: 512,
      referenceFormat: "png",
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
      // No documented reference size for this model; the retained 512 px fit.
      referenceDimension: 512,
      referenceFormat: "png",
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
    sizes: gptImageSizes,
    input: {
      transport: "json",
      dimensions: "own",
      maxDimension: GPT_IMAGE_MAX_EDGE,
      maxDimensionDocumented: true,
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
      // Neither OpenAI nor Cloudflare documents an input size for this model;
      // it reads every input at high fidelity and is reported to upscale
      // small inputs toward 1024 px, so 512 px references were upscaled blur.
      // 1024 px is also the edge of its documented 1024x1024 output.
      referenceDimension: 1024,
      // Its `images[]` data URIs accept webp (Cloudflare schema); WebP keeps
      // 16 references well under the request body bound that PNG would break.
      referenceFormat: "webp",
    },
  }),
  freezeModel({
    id: "bytedance/seedream-5-pro",
    // The page documents no prompt maxLength (schema-input.json has none):
    // keep the 2,048 host cap.
    maxPromptLength: UNDOCUMENTED_PROMPT_LENGTH,
    // The page's example results are .jpeg URLs; the schema has no format field.
    outputFormats: Object.freeze(["jpeg"]),
    tier: "premium",
    label: "Seedream 5 Pro — ByteDance, high-quality images",
    sizes: seedreamSizes,
    input: {
      transport: "json",
      dimensions: "own",
      // The longest listed edge: the page documents no maximum.
      maxDimension: 1792,
      maxDimensionDocumented: false,
      defaultWidth: 1536,
      defaultHeight: 864,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: null,
      // The page says the model takes up to 10 reference images (`image`, a
      // string or 1-10 strings) but shows only URL inputs and states no
      // base64 or data-URI form, so Prints sends none until it does.
      referenceField: null,
      maxReferences: 0,
      referenceDimension: 512,
      referenceFormat: "png",
    },
  }),
  videoModel(
    mediaVideoModelIdSchema.enum.seedance25,
    "Seedance 2.5",
    "balanced",
    "seedance",
    [
      ["480p", 10_280, 10_280],
      ["720p", 23_120, 23_120],
    ],
    seedance25,
  ),
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
  // ElevenLabs on Unified Billing: URL results, like the video models.
  speechModel(
    mediaAudioModelIdSchema.enum.multilingual,
    "Eleven Multilingual v2 — natural speech",
    "balanced",
    10,
  ),
  speechModel(
    mediaAudioModelIdSchema.enum.v3,
    "Eleven v3 — expressive speech",
    "premium",
    10,
  ),
  musicModel(),
]);

/** The Fungi gateway provider's own immutable image, video and audio model catalog. */
export const mediaModels: readonly MediaModel[] = models;
/**
 * One catalogue entry. Same grammar as the gateway's wire entry, except that a
 * video model may name `host` as its provider family: the injected provider
 * owns that model's wire grammar and Darkroom builds no gateway request for it.
 */
export const mediaCatalogueModelSchema = mediaModelSchema
  .unwrap()
  .extend({
    /** Speech or music constraints; a host's catalogue omits it unless it lists audio models. */
    audio: mediaAudioSchema.unwrap().nullable().default(null),
    /** Video length constraints, or null for a still-image model. */
    video: mediaVideoSchema
      .unwrap()
      .unwrap()
      .extend({
        /** Audio reference limits; a host's catalogue omits it unless its model takes audio references. */
        audioReferences: mediaVideoSchema
          .unwrap()
          .unwrap()
          .shape.audioReferences.default(null),
        /** Provider translation family, or `host` for a host-injected provider. */
        provider: z.enum({
          /** Seedance integer duration and data-URI image fields. */
          seedance: "seedance",
          /** Veo duration string and base64 image_input. */
          veo: "veo",
          /** MiniMax multimodal `content[]` array and uppercase resolution. */
          minimax: "minimax",
          /** The injected provider owns the wire grammar. */
          host: "host",
        }),
      })
      .readonly()
      .nullable(),
  })
  .readonly();
/** One provider's catalogue entry. */
export type MediaCatalogueModel = z.output<typeof mediaCatalogueModelSchema>;
/** One provider's model list: the typed bounds every request is checked against. */
export type MediaCatalogue = readonly MediaCatalogueModel[];
/** Upper bound on one provider's model list. */
const MAX_CATALOGUE_MODELS = 256;

/**
 * Decode a host-supplied provider catalogue. Each entry is the same typed wire
 * grammar the built-in catalogue uses; this adds the cross-field facts the
 * validator relies on (unique ids, video metadata iff `kind` is video, defaults
 * inside their own bounds).
 */
export const mediaCatalogueSchema = z
  .array(mediaCatalogueModelSchema)
  .min(1)
  .max(MAX_CATALOGUE_MODELS)
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    entries.forEach((model, index) => {
      const report = (message: string) => {
        context.addIssue({ code: "custom", message, path: [index] });
      };
      if (seen.has(model.id)) report(`duplicate model id "${model.id}"`);
      seen.add(model.id);
      if ((model.kind === "video") !== (model.video !== null))
        report(
          `${model.id} must carry video bounds exactly when kind is video`,
        );
      if ((model.kind === "audio") !== (model.audio !== null))
        report(
          `${model.id} must carry audio bounds exactly when kind is audio`,
        );
      const video = model.video;
      if (video === null) return;
      if (
        video.minSeconds > video.maxSeconds ||
        video.durations.some(
          (seconds) => seconds < video.minSeconds || seconds > video.maxSeconds,
        ) ||
        !video.durations.includes(video.defaultSeconds)
      )
        report(
          `${model.id} durations must sit inside min/max and include the default`,
        );
      if (
        !video.formats.some(
          ({ resolution, aspectRatio }) =>
            resolution === video.defaultResolution &&
            aspectRatio === video.defaultAspectRatio,
        )
      )
        report(
          `${model.id} formats must include the default resolution and aspect`,
        );
    });
  })
  .transform((entries): MediaCatalogue =>
    Object.freeze(
      entries.map((model) =>
        Object.freeze({ ...model, input: Object.freeze(model.input) }),
      ),
    ),
  );

/** Decode untrusted catalogue data, throwing a MediaSettingsError that names the first problem. */
export const parseMediaCatalogue = (raw: unknown): MediaCatalogue => {
  const parsed = mediaCatalogueSchema.safeParse(raw);
  if (!parsed.success)
    throw new MediaSettingsError(
      `media catalogue is invalid: ${parsed.error.issues[0]?.message ?? "unreadable"}`,
    );
  return parsed.data;
};

/** List the gateway provider's models in catalog order. */
export const listMediaModels = (): readonly MediaModel[] => mediaModels;
/** Find a model in the Fungi gateway's own catalogue; gateway-internal code never sees a custom provider's models. */
export const getGatewayModel = (id: string): MediaModel | undefined =>
  mediaModels.find((model) => model.id === id);
/** Find a model in `catalogue` (the gateway's by default), or undefined when absent. */
export const getMediaModel = (
  id: string,
  catalogue: MediaCatalogue = mediaModels,
): MediaCatalogueModel | undefined =>
  catalogue.find((model) => model.id === id);

/** Invalid generation settings or unsupported model parameters. */
export class MediaSettingsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaSettingsError";
  }
}
