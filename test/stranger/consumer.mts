// Browser profile: the DOM-facing Darkroom entries (app-media-contracts,
// provenance) and Agar's media handles, with every shared declaration checked
// strictly. The Worker-side entries are in consumer-worker.mts.
/// <reference lib="es2023" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext.disposable" />
import {
  MediaGeneration,
  MediaGenerationAttempt,
  type MediaGenerationJsonCaller,
} from "@fungi.computer/agar/media-json";

import type {
  MediaGenerationHandle,
  MediaGenerationAttemptHandle,
} from "@fungi.computer/agar/media";
import type { AppHostLaunch } from "@fungi.computer/agar/host";
const call: MediaGenerationJsonCaller = (method) =>
  Promise.resolve(
    method === "describe"
      ? { computerId: "local", canGenerate: true, models: [] }
      : null,
  );
export const handle: MediaGenerationHandle = new MediaGeneration(call, "local");
export const createHandle: (
  caller: MediaGenerationJsonCaller,
) => AppHostLaunch["capabilities"][number]["handle"] = (caller) =>
  new MediaGeneration(caller, "local");
export function attemptType(
  attempt: MediaGenerationAttempt,
): MediaGenerationAttemptHandle {
  return attempt;
}

import { stripPrivateProvenance } from "@fungi.computer/darkroom/provenance";
import {
  appMediaGenerationResultSchema,
  destinationSchema,
  mediaModelsSchema,
  appMediaGenerationOutcomeSchema,
  appMediaModelsOutcomeSchema,
} from "@fungi.computer/darkroom/app-media-contracts";

void mediaModelsSchema.parse([]);
void destinationSchema.parse({ computerId: "local", path: "/picture.png" });
void appMediaGenerationResultSchema;
void appMediaModelsOutcomeSchema.parse({ error: "not_granted" });
void appMediaGenerationOutcomeSchema.parse({
  kind: "pending",
  retryAfterMs: 5000,
});
void stripPrivateProvenance;
