import { describe, expect, it } from "vitest";
import {
  referenceImageSizeIsValid,
  referenceImageTransform,
} from "../src/reference-image-size.js";

describe("model-specific reference image sizing", () => {
  it.each([
    {
      model: "bytedance/seedance-2.0",
      width: 1774,
      height: 887,
      expected: { width: 640, height: 320, fit: "contain" },
    },
    {
      model: "bytedance/seedance-2.0",
      width: 887,
      height: 1774,
      expected: { width: 320, height: 640, fit: "contain" },
    },
    {
      model: "openai/gpt-image-2",
      width: 2048,
      height: 1024,
      expected: { width: 1024, height: 512, fit: "scale-down" },
    },
    {
      model: "openai/gpt-image-2",
      width: 800,
      height: 600,
      expected: { width: 800, height: 600, fit: "scale-down" },
    },
    {
      model: "@cf/black-forest-labs/flux-2-klein-4b",
      width: 1774,
      height: 887,
      expected: { width: 512, height: 256, fit: "scale-down" },
    },
    {
      model: "@cf/black-forest-labs/flux-2-klein-4b",
      width: 887,
      height: 1774,
      expected: { width: 256, height: 512, fit: "scale-down" },
    },
  ])(
    "fits $model $width×$height to its model-specific reference dimensions",
    ({ model, width, height, expected }) => {
      expect(referenceImageTransform(model, width, height)).toEqual(expected);
    },
  );

  it("accepts 1024 px GPT Image 2 references and refuses 1025 px or 513 px elsewhere", () => {
    expect(referenceImageSizeIsValid("openai/gpt-image-2", 1024, 768)).toBe(
      true,
    );
    expect(referenceImageSizeIsValid("openai/gpt-image-2", 1025, 768)).toBe(
      false,
    );
    expect(
      referenceImageSizeIsValid(
        "@cf/black-forest-labs/flux-2-klein-4b",
        513,
        1,
      ),
    ).toBe(false);
  });

  it("refuses a 512×256 video reference even though it fits the image long-edge cap", () => {
    expect(referenceImageSizeIsValid("bytedance/seedance-2.0", 512, 256)).toBe(
      false,
    );
  });
});
