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

import {
  listMediaModels,
  validateMediaVideoSelection,
  estimateVideoMilliunits,
  type MediaVideoSelectionInput,
  type MediaVideoReferenceRole,
  type MediaProvider,
} from "@fungi.computer/darkroom";
import {
  createMediaService,
  generateMedia,
  MediaOperationOwner,
  type MediaServiceHost,
  type MediaOperationContext,
  type MediaOperationBucket,
} from "@fungi.computer/darkroom/server";
import { stripPrivateProvenance } from "@fungi.computer/darkroom/provenance";
import { runMediaGeneration } from "@fungi.computer/darkroom/effect";
import {
  appMediaGenerationResultSchema,
  destinationSchema,
  mediaModelsSchema,
  appMediaGenerationOutcomeSchema,
  appMediaModelsOutcomeSchema,
} from "@fungi.computer/darkroom/app-media-contracts";

void mediaModelsSchema.parse(listMediaModels());
void destinationSchema.parse({ computerId: "local", path: "/picture.png" });
void appMediaGenerationResultSchema;
void appMediaModelsOutcomeSchema.parse({ error: "not_granted" });
void appMediaGenerationOutcomeSchema.parse({
  kind: "pending",
  retryAfterMs: 5000,
});

export function service(
  context: MediaOperationContext,
  bucket: MediaOperationBucket,
  provider: MediaProvider,
) {
  const operation = new MediaOperationOwner(
    context,
    { APP_ARTIFACTS: bucket },
    () => provider,
  );
  const host: MediaServiceHost = {
    scope: {
      actorId: "reader",
      namespace: "studio",
      owner: "illustrator",
      destinationId: "pictures",
    },
    operations: { getByName: () => operation },
    provider,
    metering: "unmetered",
    destination: {
      authorize: () => Promise.resolve(),
      write: () => Promise.resolve(),
    },
  };
  return createMediaService(host);
}
void listMediaModels();
void stripPrivateProvenance;
void runMediaGeneration;

const videoInput: MediaVideoSelectionInput = {
  model: "google/veo-3.1-fast",
  prompt: "a greenhouse at dawn",
  durationSeconds: 6,
  references: [{ path: "greenhouse.png", role: "first-frame" }],
};
const selectedVideo = validateMediaVideoSelection(videoInput);
const frameRole: MediaVideoReferenceRole = "last-frame";
void frameRole;
void estimateVideoMilliunits(selectedVideo);
void generateMedia;
