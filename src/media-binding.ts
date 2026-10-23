import * as z from "zod";
import * as Schema from "effect/Schema";
import { pending } from "@fungi.computer/agar/backend-definition";
import { mediaRequestIdSchema } from "@fungi.computer/agar/media-request-id";
import { mediaLibraryPathSchema } from "@fungi.computer/agar/media-library";
import {
  getMediaModel,
  mediaGenerationSelectionSchema,
  mediaRequestedImageFormatSchema,
  mediaVideoSelectionSchema,
  validateMediaGenerationSelection,
  validateMediaVideoSelection,
  MediaSettingsError,
  readResponseBytes,
  type MediaGenerationSettings,
} from "./index.js";
export { mediaResultSchema } from "./media-operation-contract.js";
import { mediaFailureSchema } from "./browser-failure.js";
import {
  appMediaBrokerFailureSchema,
  appMediaGenerationResultSchema,
  mediaModelsSchema,
} from "./app-media-contracts.js";

/** The App owns its folder; the host owns Computer identity and the output filename. */
const mediaBindingLibraryPathSchema = z
  .string()
  .refine(
    Schema.is(mediaLibraryPathSchema),
    "Select an absolute library folder",
  );
/** Image settings and path references crossing a scoped MEDIA binding. */
export const mediaImageBindingInputSchema = z.strictObject({
  /** Select image generation rather than video. */
  kind: z.literal("image"),
  /** Attempt identity retained through polling and replay. */
  requestId: mediaRequestIdSchema,
  /** App-owned absolute folder; the host supplies Computer authority. */
  libraryPath: mediaBindingLibraryPathSchema,
  /** Image model selection, references and inference settings. */
  settings: mediaGenerationSelectionSchema
    .omit({ durationSeconds: true })
    .extend({
      /** Optional inference-step count for models that support it. */
      steps: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .refine(
      (settings) => getMediaModel(settings.model)?.kind === "image",
      "Select an image model from listModels",
    ),
  /** Requested image encoding, validated against the selected model. */
  outputFormat: mediaRequestedImageFormatSchema.optional(),
});
/** Video settings and path references crossing the same scoped binding. */
export const mediaVideoBindingInputSchema = z.strictObject({
  /** Select video generation rather than an image. */
  kind: z.literal("video"),
  /** Attempt identity retained through polling and replay. */
  requestId: mediaRequestIdSchema,
  /** App-owned absolute folder; the host supplies Computer authority. */
  libraryPath: mediaBindingLibraryPathSchema,
  /** Catalog-backed video model, size, duration and references. */
  settings: mediaVideoSelectionSchema,
});
/** One generation identity, including the App-owned folder captured for replay. */
export const mediaBindingGenerationSchema = z.discriminatedUnion("kind", [
  mediaImageBindingInputSchema,
  mediaVideoBindingInputSchema,
]);
/** Parsed generation command consumed by either host. */
export type MediaBindingGeneration = z.output<
  typeof mediaBindingGenerationSchema
>;
/** Maintained MEDIA method grammar; guest input carries no principal or Computer. */
export const mediaBindingCallSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    /** Read the model catalog without dispatching generation. */
    operation: z.literal("models"),
    /** Catalog reads carry no guest authority or generation settings. */
    input: z.strictObject({}),
  }),
  z.strictObject({
    /** Execute or poll one admitted generation identity. */
    operation: z.literal("generate"),
    /** The App's captured generation selection and library folder. */
    input: mediaBindingGenerationSchema,
  }),
]);
/** Parsed call consumed by host admission and transport. */
export type MediaBindingCall = z.output<typeof mediaBindingCallSchema>;
/** Background-generation reply emitted by the durable service. */
export const mediaPendingSchema = z.lazy(() =>
  z.strictObject({
    /** Background work has been accepted but is not yet delivered. */
    status: z.literal("pending"),
    /** Host-supplied delay before polling the same attempt again. */
    retryAfterSeconds: z.number().int().positive(),
  }),
);
/** Parsing and model refusal stay shared; authorization remains host-owned. */
export function parseMediaBindingCall(raw: z.core.util.JSONType):
  | Readonly<{
      /** The binding input passed its shared grammar. */
      kind: "parsed";
      /** Validated command for host admission. */
      call: MediaBindingCall;
    }>
  | Readonly<{
      /** Input size, grammar or model selection was refused. */
      kind: "refused";
      /** Safe refusal returned without provider dispatch. */
      result: z.core.util.JSONType;
    }> {
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 64 * 1024)
    return { kind: "refused", result: { error: "too_large" } };
  const parsed = mediaBindingCallSchema.safeParse(raw);
  if (!parsed.success) return { kind: "refused", result: { error: "invalid" } };
  if (parsed.data.operation === "generate") {
    try {
      if (parsed.data.input.kind === "image")
        validateMediaGenerationSelection(parsed.data.input.settings);
      else validateMediaVideoSelection(parsed.data.input.settings);
    } catch (cause) {
      if (!(cause instanceof MediaSettingsError)) throw cause;
      return {
        kind: "refused",
        result: {
          error: "INVALID_ARGUMENT",
          message: cause.message,
          stage: "settings",
          retryable: false,
        },
      };
    }
  }
  return { kind: "parsed", call: parsed.data };
}
/** Relative service input after the host attaches its trusted Computer to references. */
export type MediaBindingRequest = Readonly<{
  /** Host-selected output filename within the App's library folder. */
  path: string;
  /** Validated selection with the host's Computer attached to references. */
  settings: MediaGenerationSettings;
  /** Optional image encoding; video output remains MP4. */
  outputFormat?: z.output<typeof mediaRequestedImageFormatSchema>;
}>;
/** Choose the same fixed filename on both hosts without a recursive App lookup. */
export function mediaBindingRequest(
  input: MediaBindingGeneration,
  computerId: string,
): MediaBindingRequest {
  const selected =
    input.kind === "image"
      ? validateMediaGenerationSelection(input.settings)
      : validateMediaVideoSelection(input.settings);
  const { references, ...settings } = selected;
  const model = getMediaModel(input.settings.model);
  const format =
    input.kind === "video"
      ? "mp4"
      : (input.outputFormat ??
        (model?.outputFormats.includes("png")
          ? "png"
          : (model?.outputFormats[0] ?? "png")));
  let attached: MediaGenerationSettings = settings;
  if (references !== undefined)
    attached = {
      ...settings,
      references: references.map((reference) => ({ ...reference, computerId })),
    };
  const request: MediaBindingRequest = {
    path: `${input.libraryPath}/prints-${input.requestId}.${format}`,
    settings: attached,
  };
  if (input.kind === "image" && input.outputFormat !== undefined)
    return { ...request, outputFormat: input.outputFormat };
  return request;
}
/** Decode bounded service replies once for both MEDIA host bindings. */
export async function readMediaBindingReply(
  input: MediaBindingCall,
  computerId: string,
  response: Response,
): Promise<z.core.util.JSONType> {
  const bytes = await readResponseBytes(
    new Response(response.body, { headers: response.headers }),
    240 * 1024,
  );
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok) {
    const failure = mediaFailureSchema.safeParse(value);
    if (!failure.success) return { error: "unavailable" };
    const projected: z.input<typeof appMediaBrokerFailureSchema> = {
      error: failure.data.code,
      message: failure.data.error,
      stage: failure.data.stage,
      retryable: failure.data.retryable,
    };
    if (failure.data.provider !== undefined)
      projected.provider = failure.data.provider;
    return z.json().parse(appMediaBrokerFailureSchema.parse(projected));
  }
  if (input.operation === "models")
    return z.json().parse(mediaModelsSchema.parse(value));
  if (response.status === 202) {
    if (input.input.kind === "image") return { error: "unavailable" };
    return z
      .json()
      .parse(pending(mediaPendingSchema.parse(value).retryAfterSeconds * 1000));
  }
  const result = appMediaGenerationResultSchema.parse(value);
  if (
    result.destination.computerId !== computerId ||
    (input.input.kind === "video"
      ? result.format !== "mp4"
      : input.input.outputFormat !== undefined &&
        result.format !== input.input.outputFormat)
  )
    return { error: "unavailable" };
  return z.json().parse(result);
}
