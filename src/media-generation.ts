import * as Effect from "effect/Effect";
import {
  getMediaModel,
  validateMediaGenerationSettings,
  resolveMediaReferences,
  MediaSettingsError,
} from "./index.js";
import { estimate } from "./cloudflare/provider.js";
import { executeMediaOperation } from "./media-operation.js";
import type { MediaExecution } from "./media-operation-contract.js";
import { MediaExecutionError } from "./execution-error.js";
import { mediaResultSchema } from "./media-operation-contract.js";
import type {
  MediaServiceHost,
  MediaGenerationRequest,
  MediaGenerationOutcome,
} from "./server.js";

/**
 * Validate, admit, dispatch and save one generation against `host`. Shared by
 * the `/generate` Hono route and the Agent image tool so both run the exact
 * same admission, billing and destination-write sequence.
 */
export function runMediaGeneration(
  host: MediaServiceHost,
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Effect.Effect<
  MediaGenerationOutcome,
  MediaExecutionError | MediaSettingsError
> {
  return Effect.gen(function* () {
    const settings = yield* Effect.try({
      try: () => validateMediaGenerationSettings(request.settings),
      catch: () => new MediaSettingsError("invalid generation settings"),
    });
    if (
      request.outputFormat !== undefined &&
      !getMediaModel(settings.model)?.outputFormats.includes(
        request.outputFormat,
      )
    )
      return yield* Effect.fail(
        new MediaSettingsError(
          "model cannot produce the requested image format",
        ),
      );
    const path = request.path;
    const beforeAdmit = host.beforeAdmit;
    if (beforeAdmit !== undefined)
      yield* Effect.tryPromise({
        try: () => beforeAdmit(request.requestId),
        catch: (cause) =>
          new MediaExecutionError("generation-authorization", { cause }),
      });
    const execution: Omit<MediaExecution, "signal"> & {
      signal?: AbortSignal;
    } = {
      operation: host.operations.getByName(`media:${request.requestId}`),
      actorUserId: host.scope.actorId,
      coordinates: {
        namespace: host.scope.namespace,
        owner: host.scope.owner,
      },
      requestId: request.requestId,
      request: {
        ...settings,
        computerId: host.scope.destinationId,
        path,
        outputFormat: request.outputFormat,
      },
      metering: host.metering,
      destination: {
        authorize: () => host.destination.authorize(path),
        write: (bytes) => host.destination.write(path, bytes),
      },
      generation: {
        prepare: async () => {
          const references = await resolveMediaReferences(settings, {
            read: (reference) => {
              if (host.destination.readReference === undefined)
                throw new MediaSettingsError(
                  "reference images are unavailable",
                );
              return host.destination.readReference(reference);
            },
          });
          const costMilliunits = estimate(settings, references);
          // Reference preparation may suspend. This final authority check is
          // the new-generation admission cutoff, before durable dispatch.
          try {
            await host.authorizeGeneration?.();
          } catch (cause) {
            throw new MediaExecutionError("generation-authorization", {
              cause,
            });
          }
          return {
            costMilliunits,
            references,
            run: (runSignal?: AbortSignal) =>
              host.provider(
                settings,
                references,
                runSignal,
                request.outputFormat,
              ),
          };
        },
      },
    };
    if (signal !== undefined) execution.signal = signal;
    const outcome = yield* executeMediaOperation(execution);
    if (outcome.kind === "conflict") return { kind: "conflict" as const };
    if (
      outcome.kind === "accepted" ||
      (outcome.kind === "pending" &&
        getMediaModel(settings.model)?.kind === "video")
    )
      // A video generation runs in the background; retry this request id.
      return {
        kind: "pending" as const,
        background: true,
        retryAfterSeconds: 5,
      };
    if (outcome.kind === "pending")
      return {
        kind: "pending" as const,
        background: false,
        retryAfterSeconds: 5,
      };
    if (outcome.kind === "interrupted") return { kind: "interrupted" as const };
    if (outcome.kind !== "succeeded") return { kind: "unavailable" as const };
    return {
      kind: "succeeded" as const,
      bytes: outcome.bytes,
      costMilliunits: outcome.costMilliunits,
      path,
      format: mediaResultSchema.shape.format.parse(outcome.format),
      height: settings.height,
      model: settings.model,
      width: settings.width,
    };
  });
}
