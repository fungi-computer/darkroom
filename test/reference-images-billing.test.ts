import { expect, it } from "vitest";
import {
  createImagesReferenceFitter,
  createImagesViewFitter,
  imagesLegacyBillingMessage,
  type MediaImagePort,
} from "../src/cloudflare/reference-images.js";

const legacy = Object.assign(
  new Error(
    "IMAGES_TRANSFORM_ERROR 9432: Images transforms are not available using legacy billing",
  ),
  { code: 9432 },
);
const refusing: MediaImagePort = {
  info: () => Promise.reject(legacy),
  input: () => {
    throw legacy;
  },
};
const model = "@cf/black-forest-labs/flux-2-klein-4b";

it("explains Cloudflare error 9432 instead of calling the reference unsupported", async () => {
  await expect(
    createImagesReferenceFitter(refusing)(new Uint8Array([1]), model),
  ).rejects.toThrow(imagesLegacyBillingMessage);
  await expect(
    createImagesViewFitter(refusing)(new Uint8Array([1]), 512),
  ).rejects.toThrow(imagesLegacyBillingMessage);
});

it("still calls undecodable bytes an unsupported image", async () => {
  const broken: MediaImagePort = {
    ...refusing,
    info: () => Promise.reject(new Error("could not decode")),
  };
  await expect(
    createImagesReferenceFitter(broken)(new Uint8Array([1]), model),
  ).rejects.toThrow("reference image is not a supported image");
});
