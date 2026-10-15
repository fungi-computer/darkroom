/// <reference no-default-lib="true" />
/// <reference lib="es2024" />
/// <reference lib="esnext.disposable" />
/// <reference types="@cloudflare/workers-types/experimental" resolution-mode="require" />
import {
  listMediaModels,
  validateMediaGenerationSettings,
  type MediaProvider,
} from "@fungi.computer/darkroom";
import {
  createMediaService,
  MediaOperationOwner,
  type MediaOperationCoordinates,
  type MediaOperationContext,
  type MediaOperationBucket,
  type MediaServiceHost,
  type MediaMetering,
} from "@fungi.computer/darkroom/server";
import {
  MediaOperationDO,
  createWorkersAiMediaProvider,
  createImagesReferenceFitter,
  createImagesViewFitter,
  type MediaOperationCloudflareEnvironment,
} from "@fungi.computer/darkroom/cloudflare";
import { stripPrivateProvenance } from "@fungi.computer/darkroom/provenance";

const coordinates: MediaOperationCoordinates = {
  namespace: "studio",
  owner: "illustrator",
};
const settings = validateMediaGenerationSettings({
  model: "@cf/black-forest-labs/flux-1-schnell",
  prompt: "a quiet greenhouse",
  width: 1024,
  height: 768,
});
const provider: MediaProvider = () =>
  Promise.resolve({
    bytes: new Uint8Array([1]),
    format: "png",
  });

export function readerHost(
  context: MediaOperationContext,
  bucket: MediaOperationBucket,
) {
  const operation = new MediaOperationOwner(
    context,
    { APP_ARTIFACTS: bucket },
    () => provider,
  );
  const host: MediaServiceHost = {
    scope: { actorId: "reader", ...coordinates, destinationId: "pictures" },
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
export function meteredHost(base: MediaServiceHost, metering: MediaMetering) {
  return createMediaService({
    ...base,
    metering,
    refusalMessages: {
      insufficient_credits: "Refill your studio balance.",
      daily_limit_reached: "Studio quota reached.",
      denied: "Studio spending denied.",
    },
  });
}
export function nativeHost(
  state: DurableObjectState,
  env: MediaOperationCloudflareEnvironment,
  namespace: DurableObjectNamespace<MediaOperationDO>,
  ai: Ai,
  images: ImagesBinding,
) {
  const operation = new MediaOperationDO(state, env);
  const nativeProvider: MediaProvider = createWorkersAiMediaProvider(ai);
  const reference = createImagesReferenceFitter(images);
  const view = createImagesViewFitter(images);
  return { operation, namespace, nativeProvider, reference, view };
}
void settings;
void listMediaModels();
void stripPrivateProvenance(new Uint8Array());
