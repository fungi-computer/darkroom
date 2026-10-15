import { MediaSettingsError } from "../model-catalog.js";
import { gatewayOutputSchema } from "../gateway-wire.js";
import { imageBase64, imageDataUri } from "./reference-encoding.js";
import type { VideoProviderAdapter } from "./types.js";

export type UnifiedGatewayInput = {
  prompt: string;
  duration: string | number;
  resolution: string;
  aspect_ratio: string;
  generate_audio?: boolean;
  image?: string;
  last_frame_image?: string;
  reference_images?: string[];
  image_input?: string;
};

/**
 * Seedance and Veo share the Unified AI gateway's `{state, result}` answer
 * and a flat prompt/image request body; only a few fields differ by
 * provider, handled inline below.
 */
export const unifiedVideoAdapter: VideoProviderAdapter = {
  buildInput(checked, references, model) {
    const veo = model.video?.provider === "veo";
    const input: UnifiedGatewayInput = {
      prompt: checked.prompt,
      duration: veo
        ? `${String(checked.durationSeconds)}s`
        : checked.durationSeconds,
      resolution: checked.resolution,
      aspect_ratio: checked.aspectRatio,
    };
    if (checked.generateAudio !== undefined)
      input.generate_audio = checked.generateAudio;
    const referenceImages: string[] = [];
    references.forEach((image, index) => {
      const role = checked.references?.[index]?.role;
      if (veo) {
        input.image_input = imageBase64(image);
      } else if (role === "first-frame") {
        input.image = imageDataUri(image);
      } else if (role === "last-frame") {
        input.last_frame_image = imageDataUri(image);
      } else if (role === "reference") {
        referenceImages.push(imageDataUri(image));
      } else
        throw new MediaSettingsError("video reference role was not admitted");
    });
    if (referenceImages.length > 0) input.reference_images = referenceImages;
    return input;
  },
  decodeResultUrl(providerValue) {
    const parsed = gatewayOutputSchema.parse(providerValue);
    if (parsed.state !== "Completed")
      throw new Error("gateway video result is not completed");
    if (parsed.result.video === undefined)
      throw new Error("gateway video result has no URL");
    return parsed.result.video;
  },
};
