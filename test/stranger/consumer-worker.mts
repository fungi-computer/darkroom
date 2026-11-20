// Worker profile: the consumer's use of the Worker-side Darkroom entries (the
// root, server and effect), checked against the runtime types Wrangler
// generates for the standalone example's config. Shared declarations are
// checked strictly by the browser profile in consumer.mts.
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
import { runMediaGeneration } from "@fungi.computer/darkroom/effect";
import { mediaModelsSchema } from "@fungi.computer/darkroom/app-media-contracts";

void mediaModelsSchema.parse(listMediaModels());

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
      remove: () => Promise.resolve("absent" as const),
    },
  };
  return createMediaService(host);
}
void listMediaModels();
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
