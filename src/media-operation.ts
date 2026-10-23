import {
  MediaExecutionError,
  MediaOutputFormatMismatch,
  MediaSafetyFilterRefusal,
  type MediaFailureStage,
} from "./execution-error.js";
import * as Effect from "effect/Effect";

import { mediaUnits } from "./gateway-models.js";
import { getMediaModel } from "./model-catalog.js";
import { embedProvenance, type ProvenanceEmbedResult } from "./provenance.js";
import { z } from "zod";
import type { MediaImage } from "./media-operation-owner.js";
import {
  mediaGenerationSettingsSchema,
  validateMediaGenerationSettings,
} from "./index.js";

type GeneratedMedia = Readonly<{
  /** Generated output bytes. */
  bytes: Uint8Array;
  /** Actual output encoding. */
  format: string;
}>;

import type { MediaExecution } from "./media-operation-contract.js";

function call<A>(body: () => A | Promise<A>, stage: MediaFailureStage) {
  return Effect.tryPromise({
    try: () => Promise.resolve(body()),
    catch: (cause) =>
      cause instanceof MediaExecutionError
        ? cause
        : new MediaExecutionError(stage, {
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
  });
}

function untilAborted<A>(
  signal: AbortSignal | undefined,
  body: () => Promise<A>,
) {
  if (signal === undefined) return body();
  if (signal.aborted)
    return Promise.reject(
      new Error("Media generation was cancelled", { cause: signal.reason }),
    );
  return new Promise<A>((resolve, reject) => {
    const abort = () => {
      reject(
        new Error("Media generation was cancelled", { cause: signal.reason }),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(body)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
    if (signal.aborted) abort();
  });
}

/**
 * Own one replay-safe Media execution. Network effects stay outside storage
 * transactions; the durable operation hides its transition sequence.
 */
export function executeMediaOperation(input: MediaExecution) {
  return Effect.gen(function* () {
    const admission = yield* call(
      () =>
        input.operation.admit(
          input.actorUserId,
          input.coordinates,
          input.requestId,
          input.request,
        ),
      "operation",
    );
    if (admission.kind === "conflict") return { kind: "conflict" as const };
    yield* call(input.destination.authorize, "destination-authorization");
    const metering = input.metering === "unmetered" ? null : input.metering;
    const operationId = admission.operation.operationId;
    const billed = mediaUnits(
      validateMediaGenerationSettings(
        mediaGenerationSettingsSchema.strip().parse(input.request),
      ),
    );
    const background = getMediaModel(input.request.model)?.kind === "video";
    /** Release a held price when nothing will be delivered; best effort, idempotent. */
    const settleNothing = () =>
      metering === null
        ? Effect.void
        : call(
            () => metering.settle({ operationId, units: 0 }),
            "billing",
          ).pipe(Effect.ignore);
    const claim = yield* call(() => input.operation.claim(), "operation");
    if (
      claim.kind === "succeeded" &&
      claim.operation.image !== null &&
      claim.operation.estimatedCostMilliunits !== null
    )
      return {
        kind: "succeeded" as const,
        bytes: claim.operation.image.bytes,
        format: claim.operation.image.format,
        costMilliunits: claim.operation.estimatedCostMilliunits,
      };
    if (claim.kind === "interrupted" && claim.operation.spentFailure !== null) {
      if (metering !== null)
        yield* call(
          () => metering.settle({ operationId, units: billed.units }),
          "billing",
        );
      return yield* Effect.fail(
        new MediaExecutionError("artifact", {
          cause: new MediaOutputFormatMismatch(),
        }),
      );
    }
    if (claim.kind === "interrupted") {
      yield* settleNothing();
      const failure = claim.operation.providerFailure;
      if (failure !== null)
        return yield* Effect.fail(
          failure.safetyRefused
            ? new MediaSafetyFilterRefusal({ provider: failure.provider })
            : new MediaExecutionError(failure.stage, {
                provider: failure.provider,
              }),
        );
    }
    if (claim.kind !== "claimed" || claim.leaseId === undefined)
      return {
        kind: claim.kind === "pending" ? "pending" : "unavailable",
      } as const;

    const leaseId = claim.leaseId;
    let costMilliunits: number;
    let image: MediaImage;
    if (
      claim.operation.state === "charging" &&
      claim.operation.image !== null &&
      claim.operation.estimatedCostMilliunits !== null
    ) {
      // The save committed; only the idempotent settlement remains.
      image = claim.operation.image;
      costMilliunits = claim.operation.estimatedCostMilliunits;
    } else {
      let output: GeneratedMedia;
      if (
        claim.operation.state === "writing" &&
        claim.operation.image !== null &&
        claim.operation.estimatedCostMilliunits !== null
      ) {
        output = {
          bytes: yield* call(
            () => input.operation.readGenerated(leaseId),
            "artifact",
          ),
          format: claim.operation.image.format,
        };
        costMilliunits = claim.operation.estimatedCostMilliunits;
      } else {
        // A retained save never rereads reference files or recomputes its quote.
        const releaseEstimate = () =>
          call(
            () => input.operation.releaseEstimate(leaseId),
            "operation",
          ).pipe(Effect.ignore);
        const prepared = yield* call(input.generation.prepare, "estimate").pipe(
          Effect.tapError(releaseEstimate),
        );
        // Billing admission is the last gate before durable dispatch. A refusal
        // returns the request to admitted, so the same request id can retry.
        costMilliunits =
          metering === null
            ? prepared.costMilliunits
            : (yield* call(
                () =>
                  metering.admit({
                    operationId,
                    model: input.request.model,
                    unit: billed.unit,
                    units: billed.units,
                    providerCostMilliunits: prepared.costMilliunits,
                  }),
                "billing",
              ).pipe(Effect.tapError(releaseEstimate))).priceMilliunits;
        yield* call(
          () => input.operation.recordEstimate(leaseId, costMilliunits),
          "estimate",
        );
        if (background) {
          // Video outlives one request: the owner's alarm generates, and a
          // retry of this request id saves and charges the retained output.
          yield* call(
            () =>
              input.operation.dispatchInBackground(
                leaseId,
                prepared.references,
              ),
            "operation",
          ).pipe(
            Effect.tapError(() =>
              call(
                () => input.operation.interruptGeneration(leaseId),
                "operation",
              ).pipe(Effect.andThen(settleNothing()), Effect.ignore),
            ),
          );
          return { kind: "accepted" as const };
        }
        const generation = yield* call(async () => {
          let output: GeneratedMedia;
          try {
            output = await untilAborted(input.signal, () =>
              prepared.run(input.signal),
            );
          } catch (cause) {
            if (!input.signal?.aborted) throw cause;
            await input.operation.interruptGeneration(leaseId);
            return {
              kind: "interrupted" as const,
            };
          }
          if (input.signal?.aborted) {
            await input.operation.interruptGeneration(leaseId);
            return {
              kind: "interrupted" as const,
            };
          }
          return {
            kind: "generated" as const,
            output,
          };
        }, "provider").pipe(
          // A provider failure delivered nothing and wrote no output: end the
          // request now and release its hold rather than leave it unresolved.
          Effect.tapError((error) => {
            const stage = error.stage;
            return stage === "provider" || stage === "normalization"
              ? call(
                  () =>
                    input.operation.interruptGeneration(leaseId, {
                      stage,
                      safetyRefused: error instanceof MediaSafetyFilterRefusal,
                      provider: error.provider,
                    }),
                  "operation",
                ).pipe(Effect.andThen(settleNothing()), Effect.ignore)
              : Effect.void;
          }),
        );
        if (generation.kind === "interrupted") {
          yield* settleNothing();
          return { kind: "interrupted" as const };
        }
        output = generation.output;
        const recorded = yield* call(
          () =>
            input.operation.recordGenerated(
              leaseId,
              output.bytes,
              output.format,
            ),
          "artifact",
        );
        if ("kind" in recorded) {
          // The provider ran. The owner recorded a durable spent failure before
          // this idempotent charge, so replay cannot refund or redispatch it.
          if (metering !== null)
            yield* call(
              () => metering.settle({ operationId, units: billed.units }),
              "billing",
            );
          return yield* Effect.fail(
            new MediaExecutionError("artifact", {
              cause: new MediaOutputFormatMismatch(),
            }),
          );
        }
      }

      // Embedded fresh from the recorded (unembedded) bytes on every attempt,
      // including a retry of a "writing" lease: deterministic facts in, so a
      // retry writes byte-identical output. A charged generation is never
      // failed over metadata, so a malformed or truncated provider image is
      // written as-is; embedProvenance never throws.
      const format = z
        .enum(["png", "jpeg", "gif", "webp", "mp4"])
        .safeParse(output.format);
      const provenance: ProvenanceEmbedResult = format.success
        ? yield* call(
            () =>
              embedProvenance(output.bytes, format.data, {
                printId: operationId,
                model: input.request.model,
                prompt: input.request.prompt,
                createdAt: admission.operation.createdAt,
              }),
            "operation",
          )
        : {
            bytes: output.bytes,
            embedded: false,
            reason: "unsupported-format",
          };
      if (!provenance.embedded)
        console.warn("Media provenance not embedded", {
          format: output.format,
          reason: provenance.reason,
        });
      yield* call(
        () => input.destination.write(provenance.bytes),
        "destination-write",
      ).pipe(
        Effect.tapError(() =>
          call(() => input.operation.releaseWrite(leaseId), "operation").pipe(
            Effect.ignore,
          ),
        ),
      );
      image = {
        bytes: provenance.bytes.byteLength,
        format: output.format,
      };
      if (metering === null) {
        yield* call(
          () =>
            input.operation.recordWrittenWithoutSettlement(
              leaseId,
              "computer-write-committed",
              image,
            ),
          "operation",
        );
        return {
          kind: "succeeded" as const,
          bytes: image.bytes,
          format: image.format,
          costMilliunits,
        };
      }
      yield* call(
        () =>
          input.operation.recordWritten(
            leaseId,
            "computer-write-committed",
            image,
          ),
        "operation",
      );
    }
    if (metering === null) return { kind: "unavailable" as const };
    yield* call(
      () => metering.settle({ operationId, units: billed.units }),
      "billing",
    );
    yield* call(
      () =>
        input.operation.recordSucceeded(leaseId, {
          generationId: operationId,
          bytes: image.bytes,
          format: image.format,
          costMilliunits,
        }),
      "operation",
    );
    return {
      kind: "succeeded" as const,
      bytes: image.bytes,
      format: image.format,
      costMilliunits,
    };
  });
}
