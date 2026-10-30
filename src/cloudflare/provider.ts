import { z } from "zod";
import * as Redacted from "effect/Redacted";
import {
  buildProviderInput,
  getMediaModel,
  estimateImageMilliunits,
  normalizeMediaProviderOutput,
  mediaProviderWireSchema,
  validateMediaGenerationSettings,
  type MediaModel,
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
  decodeMediaProviderErrorCategory,
  type MediaProviderDiagnostic,
} from "@fungi.computer/agar/errors";
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

/** Quote the catalog defaults through the exact estimator used before dispatch. */
export function estimateMediaModel(model: MediaModel) {
  const settings = validateMediaGenerationSettings({
    model: model.id,
    prompt: "x",
    width: model.input.defaultWidth,
    height: model.input.defaultHeight,
  });
  return {
    /** An indicative quote, not an admitted generation receipt. */
    kind: "estimate" as const,
    /** Provider cost before the host's billing policy. */
    basis: "provider-cost" as const,
    /** Catalog defaults, a one-character prompt and no references. */
    settings,
    /** Estimated provider milliunits of a cent for these exact settings. */
    costMilliunits: estimate(settings, []),
  };
}

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
      return estimateGatewayMilliunits(settings, references);
    return estimateImageMilliunits(settings.model, params);
  } catch (cause) {
    throw new MediaExecutionError("estimate", { cause });
  }
}

// Workers AI prefixes upstream error messages with its numeric internal code.
// Parse only that bounded identifier; printable prose is separately decoded.
const providerFailureCode = z.lazy(() =>
  z
    .string()
    .regex(/^\d{4,5}: /u)
    .transform((message) => Number(message.split(":", 1)[0]))
    .nullable()
    .catch(null),
);

// Observed in a real Flux replay: HTTP 400/code 3030. Match the complete
// bounded refusal, not 3030 itself; the code is not documented as transient.
const outputFlaggedMessage = z
  .string()
  .regex(
    /^(?:\d{4,5}: )?(?:AiError: ){0,3}Your output has been flagged\. Please choose another prompt \/ input image combination \([0-9a-f-]{36}\)$/u,
  );

// Recognize the refusal, not the generic Workers AI error number or prompt text.
const safetyFilterMessage = z.lazy(() =>
  z.union([
    outputFlaggedMessage,
    z
      .string()
      .regex(/(?:^|:\s)(?:AiError:\s)?Input prompt contains NSFW content\b/iu),
    // Veo's documented input-policy refusal; keep its details private as well.
    // https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/responsible-ai-and-usage-guidelines
    z.string().regex(/\bit might violate our policies\b/iu),
  ]),
);

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

/**
 * The one AI Gateway routing rule: a call keeps the host's gateway option only
 * when its input is gateway-compatible.
 * - A stream input never is. The binding's documented multipart input is a
 *   ReadableStream body
 *   (https://developers.cloudflare.com/changelog/2025-11-25-flux-2-dev-workers-ai/),
 *   and the gateway route rejects it: "AI Gateway does not support
 *   ReadableStreams yet".
 * - An image or frame input never is. AI Gateway documents no request body
 *   limit (https://developers.cloudflare.com/ai-gateway/reference/limits/), yet
 *   it rejects a first-frame Seedance request (~700 KB data URI) with
 *   `7003: User Input Error` that succeeds on the direct binding.
 * Metering stays correct either way: Media meters from its own estimate, not
 * from gateway logs.
 */
function routedOptions(
  options: AiOptions | undefined,
  signal: AbortSignal | undefined,
  input: Readonly<{ stream: boolean; images: number }>,
): AiOptions | undefined {
  const compatible = !input.stream && input.images === 0;
  if (compatible || options === undefined)
    return signal === undefined ? options : { ...options, signal };
  const { gateway, ...direct } = options;
  void gateway;
  return signal === undefined ? direct : { ...direct, signal };
}

/** Retain the original provider failure alongside its bounded code and category. */
function providerFailure(model: string, cause: unknown): MediaExecutionError {
  const category = decodeMediaProviderErrorCategory(
    cause instanceof Error ? cause.name : undefined,
  );
  const code = providerFailureCode.parse(
    cause instanceof Error ? cause.message : undefined,
  );
  // Observed 2026-10-27 in a real GPT Image 2 call from the Prints UI:
  // "AiGatewayError: 2021: Insufficient AI Gateway credits" (no charge).
  // Sources: ~/Botanical-cto/receipts/prints-e2e/REPORT.md:51 ("Follow-up 2")
  // and ~/Botanical-cto/receipts/prints-e2e/gwfix/results.json (02:01 local;
  // call at 2026-10-27T01:01:04.296Z). The error had only name and message;
  // no HTTP status was recorded. This is observed wording, not a general
  // Cloudflare code guarantee. Keep numeric classification at this owner.
  const provider: MediaProviderDiagnostic =
    code === 2021
      ? { category, code, reason: "credits_exhausted" }
      : { category, code };
  const safeMessage = outputFlaggedMessage.safeParse(
    cause instanceof Error ? cause.message : undefined,
  );
  // The maintained Workers AI errors expose name/message, not a Response or
  // cause chain. Only the complete, bounded refusal grammar above is safe to
  // print. Unmodeled upstream prose/bodies can echo private request content;
  // retain the original error (including any nested details) only as redacted.
  console.error(
    "Media provider request failed",
    {
      model,
      providerCode: provider.code,
      category: provider.category,
      providerMessage: safeMessage.success ? safeMessage.data : undefined,
    },
    Redacted.make(cause),
  );
  return cause instanceof Error &&
    safetyFilterMessage.safeParse(cause.message).success
    ? new MediaSafetyFilterRefusal({ cause, provider })
    : new MediaExecutionError("provider", { cause, provider });
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
      routedOptions(options, signal, {
        stream: false,
        images: references.length,
      }),
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
      if (!response.ok)
        throw new MediaExecutionError("normalization", {
          provider: { category: "result_download", status: response.status },
        });
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
    if (cause instanceof MediaExecutionError) throw cause;
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
  const invoke = async (): Promise<MediaAiResult> => {
    return ai.run(
      settings.model,
      workersAiInput(providerInput),
      routedOptions(options, signal, {
        stream: providerInput.transport === "multipart",
        images: references.length,
      }),
    );
  };
  let providerValue: MediaAiResult;
  try {
    providerValue = await invoke();
  } catch (cause) {
    // Only 3040 is documented as capacity temporarily exceeded:
    // https://developers.cloudflare.com/workers-ai/platform/errors/
    // One product-call retry, never a test retry. Rebuild the multipart body
    // inside invoke: a failed binding call may already have consumed it.
    if (
      providerFailureCode.parse(
        cause instanceof Error ? cause.message : undefined,
      ) !== 3040 ||
      signal?.aborted
    )
      throw providerFailure(settings.model, cause);
    try {
      providerValue = await invoke();
    } catch (cause) {
      // One terminal diagnostic for the product call, not one per attempt.
      throw providerFailure(settings.model, cause);
    }
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
