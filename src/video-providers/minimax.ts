import * as z from "zod";
import { MediaSettingsError } from "../model-catalog.js";
import type {
  MediaVideoReferenceRole,
  MediaVideoResolution,
} from "../model-catalog.js";
import { resultUrl } from "../gateway-wire.js";
import { imageDataUri } from "./reference-encoding.js";
import type { VideoProviderAdapter } from "./types.js";

/** MiniMax's documented `content[]` image role, distinct from our neutral one. */
export type MinimaxReferenceRole =
  "first_frame" | "last_frame" | "reference_image";
/** One MiniMax `content[]` entry, exactly as its schema documents it. */
export type MinimaxContentItem =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string };
      role: MinimaxReferenceRole;
    };
/** MiniMax's documented uppercase resolution literal. */
export type MinimaxResolution = "480P" | "720P" | "768P" | "1080P" | "4K";
/** MiniMax H3 Max's documented provider body: multimodal `content[]`, not a
 * flat prompt/image/duration object. */
export type MinimaxGatewayInput = {
  content: MinimaxContentItem[];
  duration: number;
  resolution: MinimaxResolution;
  ratio: string;
};
/** Our lowercase selector to MiniMax's documented uppercase wire literal. */
const minimaxResolutionWire = {
  "480p": "480P",
  "720p": "720P",
  "768p": "768P",
  "1080p": "1080P",
  "4k": "4K",
} satisfies Record<MediaVideoResolution, MinimaxResolution>;
/** Our neutral reference role to MiniMax's documented `content[]` role. */
const minimaxRoleWire = {
  "first-frame": "first_frame",
  "last-frame": "last_frame",
  reference: "reference_image",
} satisfies Record<MediaVideoReferenceRole, MinimaxReferenceRole>;

/** MiniMax's documented task wrapper: `{task: {status, content: {url}}}`,
 * distinct from the Unified gateway's `{state, result}` shape Seedance and
 * Veo normalize into. https://developers.cloudflare.com/ai/models/minimax/h3-max/ */
const minimaxTaskOutputSchema = z.lazy(() =>
  z.looseObject({
    task: z.looseObject({
      status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
      content: z.looseObject({ url: resultUrl.optional() }).optional(),
    }),
  }),
);

export const minimaxVideoAdapter: VideoProviderAdapter = {
  buildInput(checked, references, model) {
    if (checked.generateAudio !== undefined)
      throw new MediaSettingsError(
        `${model.id} does not support an audio choice`,
      );
    const content: MinimaxContentItem[] = [
      { type: "text", text: checked.prompt },
    ];
    references.forEach((image, index) => {
      const role = checked.references?.[index]?.role;
      const wireRole = role === undefined ? undefined : minimaxRoleWire[role];
      if (wireRole === undefined)
        throw new MediaSettingsError("video reference role was not admitted");
      content.push({
        type: "image_url",
        image_url: { url: imageDataUri(image) },
        role: wireRole,
      });
    });
    const input: MinimaxGatewayInput = {
      content,
      duration: checked.durationSeconds,
      resolution: minimaxResolutionWire[checked.resolution],
      ratio: checked.aspectRatio,
    };
    return input;
  },
  decodeResultUrl(providerValue) {
    const parsed = minimaxTaskOutputSchema.parse(providerValue);
    if (parsed.task.status !== "succeeded")
      throw new Error(`minimax video task ${parsed.task.status}`);
    const url = parsed.task.content?.url;
    if (url === undefined) throw new Error("minimax video task has no URL");
    return url;
  },
};
