import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import * as ts from "typescript";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import { validateMediaGenerationSettings } from "../src/index.js";
import {
  MediaExecutionError,
  MediaSafetyFilterRefusal,
} from "../src/execution-error.js";

// The cheapest catalog video selection. These tests never dispatch to a provider.
const settings = validateMediaGenerationSettings({
  model: "bytedance/seedance-2.0-mini",
  prompt: "fern fronds unfurling",
  width: 854,
  height: 480,
  durationSeconds: 4,
});
const resultUrl = "https://results.example/clip.mp4";
const completed: MediaAiPort = {
  run: () =>
    Promise.resolve({
      state: "Completed",
      result: { video: resultUrl },
    }),
};
const mp4 = Uint8Array.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);

describe("video provider failure diagnostics", () => {
  it("reaches the real video decoder and output download with offline ports", async () => {
    const downloaded: string[] = [];
    const fetchResult: typeof fetch = (input) => {
      downloaded.push(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      return Promise.resolve(new Response(mp4));
    };
    await expect(
      generate(completed, settings, [], undefined, undefined, fetchResult),
    ).resolves.toEqual({ bytes: mp4, format: "mp4" });
    expect(downloaded).toEqual([resultUrl]);
  });

  it("retains a bounded provider category and code without the upstream message", async () => {
    // Workers AI's ordinary Error representation, not an executable-object fixture.
    const failure = new Error("3031: sanitized upstream failure");
    failure.name = "InferenceUpstreamError";
    const ai: MediaAiPort = { run: () => Promise.reject(failure) };
    await expect(generate(ai, settings, [])).rejects.toMatchObject({
      stage: "provider",
      provider: { category: "InferenceUpstreamError", code: 3031 },
    });
  });

  it("retains the native HTTP status when downloading a completed video fails", async () => {
    let downloads = 0;
    const fetchResult: typeof fetch = () => {
      downloads++;
      return Promise.resolve(new Response(null, { status: 503 }));
    };
    await expect(
      generate(completed, settings, [], undefined, undefined, fetchResult),
    ).rejects.toMatchObject({
      stage: "normalization",
      provider: { category: "result_download", status: 503 },
    });
    expect(downloads).toBe(1);
  });

  it("does not expose an arbitrary upstream name, message or cause in diagnostic JSON", async () => {
    const marker = "synthetic-private-prompt-and-result-url";
    const failure = new Error(marker);
    failure.name = marker;
    const ai: MediaAiPort = { run: () => Promise.reject(failure) };
    const error: unknown = await generate(ai, settings, []).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(MediaExecutionError);
    expect(error).toMatchObject({
      stage: "provider",
      provider: { category: "Error", code: null },
    });
    expect(JSON.stringify(error)).not.toContain(marker);
  });

  it("preserves safety-refusal identity without exposing the refusal message", async () => {
    const marker = "synthetic-private-safety-details";
    const failure = new Error(
      `3031: AiError: Input prompt contains NSFW content. ${marker}`,
    );
    failure.name = "InferenceUpstreamError";
    const ai: MediaAiPort = { run: () => Promise.reject(failure) };
    const error: unknown = await generate(ai, settings, []).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(MediaSafetyFilterRefusal);
    expect(error).toMatchObject({
      provider: { category: "InferenceUpstreamError", code: 3031 },
    });
    expect(JSON.stringify(error)).not.toContain(marker);
  });
});

describe("safe provider diagnostic contract", () => {
  it("does not add Effect imports to the generated error declaration", async () => {
    const declaration = await readFile(
      new URL("../dist/execution-error.d.ts", import.meta.url),
      "utf8",
    );
    const source = ts.createSourceFile(
      "execution-error.d.ts",
      declaration,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const effectReferences: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isStringLiteral(node) &&
        (node.text === "effect" || node.text.startsWith("effect/"))
      )
        effectReferences.push(node.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(effectReferences).toEqual([]);
  });
});
