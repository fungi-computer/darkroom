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
  kind: z.literal("image"),
  requestId: mediaRequestIdSchema,
  libraryPath: mediaBindingLibraryPathSchema,
  settings: mediaGenerationSelectionSchema
    .omit({ durationSeconds: true })
    .extend({
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
  outputFormat: mediaRequestedImageFormatSchema.optional(),
});
/** Video settings and path references crossing the same scoped binding. */
export const mediaVideoBindingInputSchema = z.strictObject({
  kind: z.literal("video"),
  requestId: mediaRequestIdSchema,
  libraryPath: mediaBindingLibraryPathSchema,
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
  z.strictObject({ operation: z.literal("models"), input: z.strictObject({}) }),
  z.strictObject({
    operation: z.literal("generate"),
    input: mediaBindingGenerationSchema,
  }),
]);
/** Parsed call consumed by host admission and transport. */
export type MediaBindingCall = z.output<typeof mediaBindingCallSchema>;
/** Background-generation reply emitted by the durable service. */
export const mediaPendingSchema = z.strictObject({
  status: z.literal("pending"),
  retryAfterSeconds: z.number().int().positive(),
});
/** Parsing and model refusal stay shared; authorization remains host-owned. */
export function parseMediaBindingCall(
  raw: Schema.Json,
):
  | Readonly<{ kind: "parsed"; call: MediaBindingCall }>
  | Readonly<{ kind: "refused"; result: z.core.util.JSONType }> {
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
  path: string;
  settings: MediaGenerationSettings;
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
    return z.json().parse(
      appMediaBrokerFailureSchema.parse({
        error: failure.data.code,
        message: failure.data.error,
        stage: failure.data.stage,
        retryable: failure.data.retryable,
      }),
    );
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
