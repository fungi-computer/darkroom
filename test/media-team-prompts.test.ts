import { describe, expect, it } from "vitest";
import { validateMediaGenerationSettings } from "../src/index.js";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import {
  dinerPrompt,
  dreamGardenPrompt,
  rallyWreckPrompt,
} from "./fixtures/media-team-prompts.js";

// The Prints-side test (apps/prints/test/media-team-prompts.test.ts) drives the
// same prompts through draft validation; this one covers the provider body.
const sizes = {
  "480p": { width: 480, height: 854 },
  "720p": { width: 720, height: 1280 },
} as const;
const prompts = [
  { name: "dream garden", prompt: dreamGardenPrompt, references: 2 },
  { name: "rally wreck", prompt: rallyWreckPrompt, references: 3 },
  { name: "diner", prompt: dinerPrompt, references: 4 },
] as const;
const mp4 = Uint8Array.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);
const png = (value: number) => ({
  bytes: new Uint8Array([value]),
  format: "png" as const,
  width: 1,
  height: 1,
});

describe.each(["bytedance/seedance-2.0", "bytedance/seedance-2.5"])(
  "media team prompts on %s",
  (model) => {
    it.each(prompts)(
      "$name reaches the provider body unaltered",
      async (entry) => {
        for (const resolution of ["480p", "720p"] as const) {
          for (const durationSeconds of [4, 6, 9]) {
            const settings = validateMediaGenerationSettings({
              model,
              prompt: entry.prompt,
              ...sizes[resolution],
              durationSeconds,
              generateAudio: true,
              references: Array.from({ length: entry.references }, (_, i) => ({
                computerId: "pictures",
                path: `/refs/${String(i + 1)}.png`,
                role: "reference" as const,
              })),
            });
            expect(settings).toMatchObject({
              aspectRatio: "9:16",
              resolution,
            });
            const bodies: unknown[] = [];
            const ai: MediaAiPort = {
              run: (_model, input) => {
                bodies.push(input);
                return Promise.resolve({
                  state: "Completed",
                  result: { video: "https://results.example/clip.mp4" },
                });
              },
            };
            await generate(
              ai,
              settings,
              Array.from({ length: entry.references }, (_, i) => png(i + 1)),
              undefined,
              undefined,
              () => Promise.resolve(new Response(mp4)),
            );
            expect(bodies).toHaveLength(1);
            expect(bodies[0]).toMatchObject({
              prompt: entry.prompt.trim(),
              aspect_ratio: "9:16",
              resolution,
              duration: durationSeconds,
              generate_audio: true,
              reference_images: Array.from(
                { length: entry.references },
                (_, i) =>
                  `data:image/png;base64,${Buffer.from([i + 1]).toString("base64")}`,
              ),
            });
          }
        }
      },
    );
  },
);
