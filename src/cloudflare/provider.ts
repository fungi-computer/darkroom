import { z } from "zod";
import * as Redacted from "effect/Redacted";
import {
  buildProviderInput,
  getMediaModel,
  estimateImageMilliunits,
  normalizeMediaProviderOutput,
  mediaProviderWireSchema,
  type MediaAiResult,
  type MediaGenerationSettings,
  type MediaProvider,
  type MediaReferenceBytes,
} from "../index.js";
import {
  MediaExecutionError,
  MediaSafetyFilterRefusal,
} from "../execution-error.js";
import {
  estimateGatewayMilliunits,
  gatewayInput,
  isGatewayModel,
} from "../gateway-models.js";
import {
  GATEWAY_VIDEO_MAX_BYTES,
  gatewayOutputSchema,
  isMp4,
} from "../gateway-wire.js";
import { videoProviderAdapters } from "../video-providers/index.js";
import { readResponseBytes } from "../index.js";

type ImageEstimateParams = {
  width: number;
  height: number;
  steps?: number;
  references?: readonly { width: number; height: number }[];
};

/** Workers AI results vary by model; the provider decodes them at this boundary. */
export type MediaAiPort = {
  /** Dispatch to the native Workers AI binding. */
  run(
    model: string,
    input: Parameters<Ai["run"]>[1],
    options?: AiOptions,
  ): Promise<MediaAiResult>;
};

export function estimate(
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[],
): number {
  const params: ImageEstimateParams = {
    width: settings.width,
    height: settings.height,
    references: references.map(({ width, height }) => ({ width, height })),
  };
  if (settings.steps !== undefined) params.steps = settings.steps;
  try {
    if (isGatewayModel(settings.model))
      return estimateGatewayMilliunits(settings);
    return estimateImageMilliunits(settings.model, params);
  } catch (cause) {
    throw new MediaExecutionError("estimate", { cause });
  }
}

// Workers AI prefixes upstream error messages with its numeric internal code.
// Parse only that bounded identifier; the remaining message is never logged.
const providerFailureCode = z
  .string()
  .regex(/^\d{4,5}: /u)
  .transform((message) => Number(message.split(":", 1)[0]))
  .nullable()
  .catch(null);

const providerFailureCategory = z
  .enum([
    "InferenceUpstreamError",
    "AiInternalError",
    "TypeError",
    "AbortError",
    "TimeoutError",
    "Error",
  ])
  .catch("Error");

// Recognize the refusal, not the generic Workers AI error number or prompt text.
const safetyFilterMessage = z.union([
  z
    .string()
    .regex(/(?:^|:\s)(?:AiError:\s)?Input prompt contains NSFW content\b/iu),
  // Veo's documented input-policy refusal; keep its details private as well.
  // https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/responsible-ai-and-usage-guidelines
  z.string().regex(/\bit might violate our policies\b/iu),
]);

/** Encode multipart once with the platform's boundary, as required by AI.run. */
function workersAiInput(payload: ReturnType<typeof buildProviderInput>) {
  if (payload.transport === "json") return { ...payload.body };
  const encoded = new Response(payload.body);
  return {
    multipart: {
      body: encoded.body,
      contentType: encoded.headers.get("Content-Type"),
    },
  };
}

/** Retain the original provider failure alongside its bounded code and category. */
function providerFailure(model: string, cause: unknown): MediaExecutionError {
  // Workers correlates this structured event with the request trace. Never log
  // the provider message/body: either can contain customer prompt content.
  console.error(
    "Media provider request failed",
    {
      model,
      providerCode: providerFailureCode.parse(
        cause instanceof Error ? cause.message : undefined,
      ),
      category: providerFailureCategory.parse(
        cause instanceof Error ? cause.name : undefined,
      ),
    },
    Redacted.make(cause),
  );
  return cause instanceof Error &&
    safetyFilterMessage.safeParse(cause.message).success
    ? new MediaSafetyFilterRefusal({ cause })
    : new MediaExecutionError("provider", { cause });
}

/** Run a gateway model and fetch its result URL within the byte bound. */
async function generateThroughGateway(
  ai: MediaAiPort,
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[],
  signal: AbortSignal | undefined,
  options: AiOptions | undefined,
  fetchResult: typeof fetch,
  outputFormat: "png" | "jpeg" | "webp" | undefined,
): Promise<{ bytes: Uint8Array; format: string }> {
  let providerValue: MediaAiResult;
  try {
    const input = gatewayInput(settings, references, outputFormat);
    providerValue = await ai.run(
      settings.model,
      input,
      signal === undefined ? options : { ...options, signal },
    );
  } catch (cause) {
    throw providerFailure(settings.model, cause);
  }
  const model = getMediaModel(settings.model);
  const video = model?.kind === "video";
  try {
    if (video) {
      if (model.video === null)
        throw new Error("video model is missing its catalog video metadata");
      const url =
        videoProviderAdapters[model.video.provider].decodeResultUrl(
          providerValue,
        );
      const response = await fetchResult(url, { signal: signal ?? null });
      if (!response.ok) throw new Error("gateway video result unavailable");
      const bytes = await readResponseBytes(response, GATEWAY_VIDEO_MAX_BYTES);
      if (!isMp4(bytes)) throw new Error("gateway video is not an MP4");
      return { bytes, format: "mp4" };
    }
    const parsed = gatewayOutputSchema.parse(providerValue);
    return await normalizeMediaProviderOutput(
      mediaProviderWireSchema.parse({
        images: [{ url: parsed.result.image }],
      }),
      { fetchUrl: (url) => fetchResult(url, { signal: signal ?? null }) },
    );
  } catch (cause) {
    throw new MediaExecutionError("normalization", { cause });
  }
}

export async function generate(
  ai: MediaAiPort,
  settings: MediaGenerationSettings,
  references: readonly MediaReferenceBytes[],
  signal?: AbortSignal,
  options?: AiOptions,
  fetchResult: typeof fetch = (input, init) => fetch(input, init),
  outputFormat?: "png" | "jpeg" | "webp",
): Promise<{ bytes: Uint8Array; format: string }> {
  if (isGatewayModel(settings.model))
    return generateThroughGateway(
      ai,
      settings,
      references,
      signal,
      options,
      fetchResult,
      outputFormat,
    );
  let providerInput: ReturnType<typeof buildProviderInput>;
  try {
    providerInput = buildProviderInput(settings, references);
  } catch (cause) {
    throw new MediaExecutionError("normalization", { cause });
  }
  let providerValue: MediaAiResult;
  try {
    providerValue = await ai.run(
      settings.model,
      workersAiInput(providerInput),
      signal === undefined ? options : { ...options, signal },
    );
  } catch (cause) {
    throw providerFailure(settings.model, cause);
  }
  try {
    return await normalizeMediaProviderOutput(
      mediaProviderWireSchema.parse(providerValue),
    );
  } catch (cause) {
    throw new MediaExecutionError("normalization", { cause });
  }
}

/** Media's provider port on the Workers AI binding, with fixed options such as the AI Gateway route. */
export function createWorkersAiMediaProvider(
  ai: MediaAiPort,
  options?: AiOptions,
): MediaProvider {
  return (settings, references, signal, outputFormat) =>
    generate(
      ai,
      settings,
      references,
      signal,
      options,
      undefined,
      outputFormat,
    );
}
