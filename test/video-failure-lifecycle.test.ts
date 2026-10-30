import { describe, expect, it } from "vitest";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import type { MediaProvider } from "../src/index.js";
import { createMediaService } from "../src/server.js";
import { readMediaFailure } from "../src/browser-failure.js";
import { MediaOperationOwner } from "../src/media-operation-owner.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";
import {
  readMediaBindingReply,
  mediaBindingCallSchema,
} from "../src/media-binding.js";
import { mediaRequestIds } from "@fungi.computer/agar/media-request-id";

// A real admitted video request, served entirely by offline ports below.
const settings = {
  model: "bytedance/seedance-2.0-mini",
  prompt: "fern fronds unfurling",
  width: 854,
  height: 480,
  durationSeconds: 4,
};

describe("background video diagnostic contract", () => {
  it.each(["dispatch", "download", "safety", "credits"])(
    "retains a %s diagnostic through alarm, restart and HTTP replay without redispatch",
    async (failureKind) => {
      const marker = "synthetic-private-background-video-details";
      const failure = new Error(
        failureKind === "credits"
          ? `2021: AiError: insufficient credits ${marker}`
          : failureKind === "safety"
            ? `3031: AiError: Input prompt contains NSFW content. ${marker}`
            : `3031: ${marker}`,
      );
      failure.name =
        failureKind === "credits" ? "Error" : "InferenceUpstreamError";
      const diagnostic =
        failureKind === "download"
          ? { category: "result_download", status: 503 }
          : failureKind === "credits"
            ? { category: "Error", code: 2021, reason: "credits_exhausted" }
            : { category: "InferenceUpstreamError", code: 3031 };
      let dispatches = 0;
      let downloads = 0;
      let writes = 0;
      const ai: MediaAiPort = {
        run: () => {
          dispatches++;
          return failureKind !== "download"
            ? Promise.reject(failure)
            : Promise.resolve({
                state: "Completed",
                result: { video: "https://results.example/clip.mp4" },
              });
        },
      };
      const fetchResult: typeof fetch = () => {
        downloads++;
        return Promise.resolve(new Response(marker, { status: 503 }));
      };
      const provider: MediaProvider = (selection, references, signal, format) =>
        generate(
          ai,
          selection,
          references,
          signal,
          undefined,
          fetchResult,
          format,
        );
      const test = mediaOperationFixture();
      let owner = new MediaOperationOwner(
        test.context,
        { APP_ARTIFACTS: test.bucket },
        () => provider,
      );
      try {
        const service = createMediaService({
          scope: {
            actorId: "actor-video",
            namespace: "team-video",
            owner: "installation-video",
            destinationId: "computer-video",
          },
          operations: { getByName: () => owner },
          provider,
          metering: "unmetered",
          destination: {
            authorize: () => Promise.resolve(),
            write: () => {
              writes++;
              return Promise.resolve();
            },
          },
        });
        const request = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": `video-${failureKind}`,
          },
          body: JSON.stringify({ settings, path: "generated/fern.mp4" }),
        };
        expect((await service.request("/generate", request)).status).toBe(202);
        await owner.alarm();
        owner = new MediaOperationOwner(
          test.context,
          { APP_ARTIFACTS: test.bucket },
          () => provider,
        );
        const response = await service.request("/generate", request);
        const status = failureKind === "safety" ? 400 : 503;
        expect(response.status).toBe(status);
        const replay = await service.request("/generate", request);
        expect(replay.status).toBe(status);
        expect(await replay.text()).not.toContain(marker);
        await owner.alarm();
        expect(dispatches).toBe(1);
        expect(downloads).toBe(failureKind === "download" ? 1 : 0);
        expect(writes).toBe(0);
        const body = await response.text();
        expect(body).not.toContain(marker);
        const browserFailure = await readMediaFailure(
          new Response(body, { status: response.status }),
        );
        expect(browserFailure).toMatchObject({
          stage: failureKind === "download" ? "normalization" : "provider",
        });
        expect(browserFailure?.provider).toEqual(diagnostic);
        const broker = await readMediaBindingReply(
          mediaBindingCallSchema.parse({
            operation: "generate",
            input: {
              kind: "video",
              requestId: mediaRequestIds.request.generate(),
              libraryPath: "/prints",
              settings: {
                model: settings.model,
                prompt: settings.prompt,
                resolution: "480p",
                durationSeconds: settings.durationSeconds,
              },
            },
          }),
          "computer-video",
          new Response(body, { status }),
        );
        expect(broker).toMatchObject({
          error:
            failureKind === "safety"
              ? "SAFETY_FILTER_REFUSED"
              : failureKind === "download"
                ? "HOST_FAILURE"
                : "MEDIA_PROVIDER_FAILURE",
          retryable: false,
        });
        expect(broker).toHaveProperty("provider", diagnostic);
        expect(JSON.stringify(broker)).not.toContain(marker);
        const stored = test.storage.sql
          .exec(
            "SELECT failure_json FROM hub_media_provider_failure WHERE singleton=1",
          )
          .toArray();
        expect(JSON.stringify(stored)).not.toContain(marker);
      } finally {
        test.close();
      }
    },
  );
});
