import { describe, expect, it } from "vitest";
import {
  getMediaModel,
  validateMediaGenerationSettings,
} from "../src/index.js";

/**
 * What each video model documents, from its Cloudflare model page (checked
 * 2026-10-26). A capability the page does not name stays out of the catalog.
 */
const documented = [
  {
    id: "bytedance/seedance-2.0",
    doc: "https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/",
    roles: ["first-frame", "last-frame", "reference"],
    maxReferenceImages: 4,
    supportsAudio: true,
    defaultGenerateAudio: null,
  },
  {
    id: "bytedance/seedance-2.0-fast",
    doc: "https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0-fast/",
    roles: ["first-frame", "last-frame", "reference"],
    maxReferenceImages: 4,
    supportsAudio: true,
    defaultGenerateAudio: null,
  },
  {
    id: "bytedance/seedance-2.0-mini",
    doc: "https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0-mini/",
    roles: ["first-frame", "last-frame", "reference"],
    maxReferenceImages: 4,
    supportsAudio: true,
    defaultGenerateAudio: null,
  },
  {
    id: "google/veo-3.1",
    doc: "https://developers.cloudflare.com/ai/models/google/veo-3.1/",
    roles: ["first-frame"],
    maxReferenceImages: 0,
    supportsAudio: true,
    defaultGenerateAudio: true,
  },
  {
    id: "google/veo-3.1-fast",
    doc: "https://developers.cloudflare.com/ai/models/google/veo-3.1-fast/",
    roles: ["first-frame"],
    maxReferenceImages: 0,
    supportsAudio: true,
    defaultGenerateAudio: true,
  },
  {
    id: "minimax/h3-max",
    doc: "https://developers.cloudflare.com/ai/models/minimax/h3-max/",
    roles: ["first-frame", "reference"],
    maxReferenceImages: 4,
    supportsAudio: false,
    defaultGenerateAudio: null,
  },
] as const;

const sized = (id: string) => {
  const video = getMediaModel(id)?.video;
  if (!video) throw new Error(`catalog missing ${id}`);
  const format = video.formats.find(
    (candidate) =>
      candidate.resolution === video.defaultResolution &&
      candidate.aspectRatio === video.defaultAspectRatio,
  );
  if (!format) throw new Error(`${id} default format missing`);
  return {
    model: id,
    prompt: "fern fronds unfurling",
    width: format.width,
    height: format.height,
  };
};
const ref = (
  role: "first-frame" | "last-frame" | "reference",
  path: string = role,
) => ({
  computerId: "pictures",
  path,
  role,
});

describe("video capabilities follow each model's documentation", () => {
  it.each(documented)("$id ($doc)", (row) => {
    const video = getMediaModel(row.id)?.video;
    expect(video?.referenceRoles).toEqual(row.roles);
    expect(video?.maxReferenceImages).toBe(row.maxReferenceImages);
    expect(video?.supportsAudio).toBe(row.supportsAudio);
    expect(video?.defaultGenerateAudio).toBe(row.defaultGenerateAudio);
  });

  it("refuses a last frame where the page names none", () => {
    for (const id of ["google/veo-3.1", "minimax/h3-max"])
      expect(() =>
        validateMediaGenerationSettings({
          ...sized(id),
          references: [ref("last-frame", "b")],
        }),
      ).toThrow(/no last frame/);
  });

  it("accepts a first and last frame on Seedance", () => {
    const settings = validateMediaGenerationSettings({
      ...sized("bytedance/seedance-2.0"),
      references: [ref("first-frame", "a"), ref("last-frame", "b")],
    });
    expect(settings.references?.map((entry) => entry.role)).toEqual([
      "first-frame",
      "last-frame",
    ]);
  });

  it("names the resolution that rules out reference mode", () => {
    expect(() =>
      validateMediaGenerationSettings({
        ...sized("bytedance/seedance-2.0"),
        resolution: "1080p",
        width: 1920,
        height: 1080,
        references: [ref("reference", "a")],
      }),
    ).toThrow(/takes reference images only at/);
  });

  it("documents audio only where the page names a field", () => {
    expect(
      validateMediaGenerationSettings({
        ...sized("bytedance/seedance-2.0"),
        generateAudio: false,
      }).generateAudio,
    ).toBe(false);
    expect(
      validateMediaGenerationSettings(sized("google/veo-3.1")).generateAudio,
    ).toBe(true);
    expect(
      validateMediaGenerationSettings(sized("minimax/h3-max")).generateAudio,
    ).toBeUndefined();
  });

  it("keeps frames and references apart", () => {
    expect(() =>
      validateMediaGenerationSettings({
        ...sized("bytedance/seedance-2.0"),
        references: [ref("first-frame", "a"), ref("reference", "b")],
      }),
    ).toThrow(/cannot be mixed/);
  });
});
