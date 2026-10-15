# Darkroom

Generate an image, keep the output, and retry a failed save without paying for
another generation. Your host supplies identity, permissions, a provider and a
place to put the file.

## Install

```sh
npm install @fungi.computer/darkroom
npm install --save-dev wrangler @cloudflare/workers-types
```

The root catalog and `server` work without a Workers runtime. The `cloudflare`
adapter runs on workerd, celld and Cloudflare with SQLite Durable Objects and
R2.

## Quick start

Save this as `worker.ts`. TypeScript hosts use
`lib: ["ES2023", "ESNext.Disposable"]` and
`types: ["@cloudflare/workers-types/experimental"]` in their compiler options.
This local example uses a fixed provider that returns a one-pixel GIF, so you
can try the save and retry path without a model account. Replace `provider` with
your own `MediaProvider` for real generation.

```ts
/// <reference types="@cloudflare/workers-types/experimental" resolution-mode="require" />
import { listMediaModels } from "@fungi.computer/darkroom";
import { createMediaService } from "@fungi.computer/darkroom/server";
import { MediaOperationDO } from "@fungi.computer/darkroom/cloudflare";

export { MediaOperationDO };

type Bindings = {
  MEDIA_OPERATION: DurableObjectNamespace<MediaOperationDO>;
  APP_ARTIFACTS: R2Bucket;
  OUTPUTS: R2Bucket;
};

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const service = createMediaService({
      scope: {
        actorId: "local-owner",
        namespace: "studio",
        owner: "illustrator",
        destinationId: "outputs",
      },
      operations: env.MEDIA_OPERATION,
      provider: async () => ({
        bytes: Uint8Array.from(
          atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
          (character) => character.charCodeAt(0),
        ),
        format: "gif",
      }),
      metering: "unmetered",
      destination: {
        authorize: async () => {},
        write: async (path, bytes) => {
          await env.OUTPUTS.put(path, bytes);
        },
      },
    });
    if (new URL(request.url).pathname === "/catalog")
      return Response.json(listMediaModels());
    return service.fetch(request);
  },
};
```

Save this as `wrangler.json`:

```json
{
  "name": "darkroom-example",
  "main": "worker.ts",
  "compatibility_date": "2026-09-02",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "MEDIA_OPERATION", "class_name": "MediaOperationDO" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MediaOperationDO"] }],
  "r2_buckets": [
    { "binding": "APP_ARTIFACTS", "bucket_name": "darkroom-retained" },
    { "binding": "OUTPUTS", "bucket_name": "darkroom-output" }
  ]
}
```

Run `npx wrangler dev --local`, then:

```sh
curl http://localhost:8787/models
curl http://localhost:8787/generate \
  -H 'Content-Type: application/json' -H 'X-Request-Id: first-picture' \
  -d '{"path":"picture.gif","settings":{"model":"@cf/black-forest-labs/flux-1-schnell","prompt":"a quiet greenhouse","width":1024,"height":768}}'
```

Repeat the same request to replay its saved result. Change the input with the
same ID and the service returns 409. This example admits one local owner. Add
your host's authentication and destination authorization before serving others.

## Core concepts

The host chooses `actorId`, `namespace`, `owner` and `destinationId`. Request
bodies cannot choose that authority. A durable operation captures its identity
and input, retains provider bytes before saving, and reuses those bytes when a
save fails. An ambiguous provider execution is never silently dispatched again.

Declare `metering: "unmetered"` when your host pays its provider directly. A
metered host supplies idempotent `admit` and `settle` functions plus its own
`refusalMessages` for insufficient credit, daily limits and denied spending.
Quotes are estimates. Your metering owner decides the customer price and
settlement.

A recognized provider safety refusal returns HTTP 400 with
`code: "SAFETY_FILTER_REFUSED"`, `stage: "provider"`, and `retryable: false`.
The public message asks you to reword the prompt; provider details stay
redacted. Nothing is saved or charged. The owner retains only the bounded
refusal reason, so same-ID replay and background video polling preserve that
verdict without calling the provider again. Workers AI's observed NSFW-input
refusal and
[Veo's documented input-policy refusal](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/responsible-ai-and-usage-guidelines)
are classified; an error number by itself is not a safety verdict.

Pre-launch operation stores must use the current fresh schema. Hosts reset old
disposable stores; Darkroom does not migrate or repair their missing refusal
fact.

Video generation runs through the operation's alarm. A 202 response tells you to
retry the same request ID after the supplied `Retry-After` delay.

## API reference

| Import                                         | Purpose                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `@fungi.computer/darkroom`                     | Model catalog, settings, references, provider wire shapes and cost estimates.  |
| `@fungi.computer/darkroom/app-media-contracts` | Runtime-neutral App catalog, destination and completed-generation schemas.     |
| `@fungi.computer/darkroom/server`              | Hono service, typed generation, metering and the portable SQL operation owner. |
| `@fungi.computer/darkroom/cloudflare`          | Native operation DO, Workers AI provider and Images fitters.                   |
| `@fungi.computer/darkroom/provenance`          | Lossless public image downloads with private metadata removed.                 |

The App-facing JSON protocol and page handles live in
`@fungi.computer/agar/media-json`. Darkroom owns host execution and its
`@fungi.computer/darkroom/browser` HTTP failure decoder.

The App contract entry exports `mediaModelsSchema`, `destinationSchema` and
`appMediaGenerationResultSchema`. The catalog bound is the maintained model
count; the host still filters models after decoding. Pending App replies use
Agar's public `pendingSchema`. `appMediaModelsOutcomeSchema` and
`appMediaGenerationOutcomeSchema` include the broker's emitted refusal payloads:
closed admission codes, the Media attachment-budget refusal, the existing
`agentAppMediaLibraryFailureSchema`, and `appMediaBrokerFailureSchema`. The
latter preserves the broker projection: HTTP `code` becomes `error`, HTTP
`error` becomes `message`, and `stage` and `retryable` stay unchanged. HTTP
failures and transport envelopes are separate representations and do not decode
as these outcomes.

See the [generated API](docs/api/README.md) for signatures and host ports. The
Cloudflare entry needs the native Workers type declarations in a TypeScript
host. The other entries use ordinary platform web types.

## Examples

For Workers AI, use `createWorkersAiMediaProvider(env.AI)` from `cloudflare` and
add an `AI` binding to your host. `createImagesReferenceFitter` prepares bounded
reference images through an Images binding. Your host authorizes each reference
read.

`stripPrivateProvenance(bytes)` from `provenance` removes prompt and lineage
metadata while preserving the AI marker, print ID and image encoding. It returns
bytes, MIME type and filename extension. The public XMP format uses
`https://fungi.computer/ns/provenance/1.0/`.

## Limits

References are bounded to four files, 512 pixels per side and 8 MiB per image.
Still-image output and public downloads are bounded to 32 MiB. Catalog models
may impose tighter limits. Video output has its own 64 MiB provider bound.

Private-provenance export supports PNG, JPEG and WebP. GIF without XMP remains
index-only. Signed, malformed and unsupported images return a typed refusal. The
original file is never changed.

## Contribute and license

MIT. See [LICENSE](LICENSE).

The `server` export provides the Promise `generateMedia(host, request, signal?)`
boundary and the relative HTTP service. Hosts composing Effect programs import
`runMediaGeneration` from `@fungi.computer/darkroom/effect`. Its advanced
declarations require the host's Effect environment; ordinary Workers consumers
need only the native Workers declarations.

## Video selections

The root export owns `mediaVideoSelectionSchema`, `validateMediaVideoSelection`,
`MediaVideoSelectionInput` and `MediaVideoSelection`. Apps select paths; their
host supplies reference authority and the MP4 destination. For example:

```ts
import {
  estimateVideoMilliunits,
  validateMediaVideoSelection,
} from "@fungi.computer/darkroom";

const selection = validateMediaVideoSelection({
  model: "bytedance/seedance-2.0-mini",
  prompt: "Fern fronds unfolding in morning light",
  resolution: "720p",
  aspectRatio: "16:9",
  durationSeconds: 5,
  references: [{ path: "fern.png", role: "first-frame" }],
});
const providerCostMilliunits = estimateVideoMilliunits(selection);
```

The strict input fields are `model`, `prompt`, optional `resolution`,
`aspectRatio`, `durationSeconds`, `generateAudio`, and optional `references`.
Each reference is `{path, role}`; role is `first-frame`, `last-frame`, or
`reference`. Normalization returns nominal `width`/`height`, explicit
resolution, aspect and duration, and the same path-only references. The host
adds its admitted `computerId` before calling the existing service. A single
untagged reference in that host service is first-frame mode, preserving the
existing Workflow caller. Unsupported combinations throw `MediaSettingsError`;
the service returns `400 INVALID_ARGUMENT` before billing admission or dispatch.

The sole model catalog describes these verified Unified AI contracts: Seedance
and Veo checked 2026-10-11, MiniMax H3 Max checked 2026-10-14. They run through
Workers `AI.run` with unprefixed IDs. Cloudflare's Workers AI `@cf/` catalog
does not supply these video IDs.

| Model                                                                                         | Resolution               | Duration                     | Reference modes                                                    | Provider USD / output second                              |
| --------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| [Seedance 2.0](https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0/)           | 480p / 720p / 1080p / 4k | integers 4–12; default 5     | first frame; first + last; 1–4 reference images except at 1080p    | .07 / .15 / .37 / .78                                     |
| [Seedance 2.0 Fast](https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0-fast/) | 480p / 720p              | integers 4–12; default 5     | first frame; first + last; 1–4 reference images                    | .06 / .12                                                 |
| [Seedance 2.0 Mini](https://developers.cloudflare.com/ai/models/bytedance/seedance-2.0-mini/) | 480p / 720p              | integers 4–12; default 5     | first frame; first + last; 1–4 reference images                    | .04 / .09                                                 |
| [Veo 3.1](https://developers.cloudflare.com/ai/models/google/veo-3.1/)                        | 720p / 1080p             | exactly 4 / 6 / 8; default 6 | one first image                                                    | .20 silent / .40 audio at either resolution               |
| [Veo 3.1 Fast](https://developers.cloudflare.com/ai/models/google/veo-3.1-fast/)              | 720p / 1080p             | exactly 4 / 6 / 8; default 6 | one first image                                                    | 720p .08 silent / .10 audio; 1080p .10 silent / .12 audio |
| [MiniMax H3 Max](https://developers.cloudflare.com/ai/models/minimax/h3-max/)                 | 480p / 768p              | integers 5–15; default 5     | first frame; first + last; 1–4 reference images, either resolution | .05 / .08 (no documented audio surcharge)                 |

Seedance and Veo default to 720p and 16:9; MiniMax H3 Max defaults to 768p and
16:9. Seedance aspects are 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, and 9:21, with fixed
24 FPS. Veo aspects are 16:9, 9:16 and 1:1. MiniMax H3 Max aspects are 16:9,
4:3, 1:1, 3:4, 9:16 and 21:9 (no 9:21; its documented `adaptive` selector, which
follows the input image's own aspect instead of a fixed box, has no nominal
pixel size and is not exposed by this catalog). Seedance prompts are at most
2,000 characters; Veo uses Darkroom's retained 2,048-character host limit
because the provider page states no prompt maximum; MiniMax H3 Max's own limit
is 7,000 but Darkroom's 2,048-character host cap binds first. Paths are trimmed,
nonblank and at most 4,096 characters; references are bounded at four overall
and refined per model (MiniMax H3 Max's own page documents up to nine, which
this four-reference host ceiling cannot reach). Last frame requires exactly one
first frame. Frame mode cannot mix with reference-image mode. Seedance's first
image can override the requested aspect; returned width/height are nominal
selectors, not measured MP4 dimensions.

Veo audio defaults to true and is always explicit in the provider request and
quote. Seedance leaves `generate_audio` unset when `generateAudio` is omitted,
because its audio default is undocumented; its non-video-input rates are the
same for either audio choice. MiniMax H3 Max has no audio field at all: its
catalog entry carries the same silent and audio rate, and `gatewayInput` throws
`MediaSettingsError` if a caller sets `generateAudio` explicitly, rather than
silently dropping the choice. `estimateVideoMilliunits` and the gateway
estimator read the catalog prices: 1 USD = 100,000 milliunits, 1 cent = 1,000.
`mediaUnits` returns `{unit: "video_second", units: durationSeconds}`. The host
still owns admission, settlement, markup and refusal copy.

Reference limits follow the explicit Seedance parameter section's four-image
grammar; its overview's larger counts remain unsupported. Veo 4k pricing does
not establish a supported 4k input, and Seedance 2.5's duration grammar remains
unverified. Video/audio references and undocumented options are refused, never
silently dropped. Seedance frames and references become data URIs; Veo's
`image_input` is plain base64; MiniMax H3 Max's are data URIs inside a
multimodal `content[]` array (`{type: "image_url", image_url: {url}, role}`),
alongside the leading `{type: "text", text: prompt}` entry — a different
provider body than Seedance or Veo's flat `prompt`/`image` fields, documented
only by the raw request/response JSON schemas the Cloudflare page links, not its
prose parameter list. MiniMax H3 Max also sends its resolution selector
uppercase (`480P`/`768P`) where every other model sends it lowercase. Every
admitted image is translated, preserving its role. All successful responses use
the existing bounded HTTPS MP4 fetch and retention path (64 MiB maximum).
Seedance and Veo answer with the Unified gateway's normalized
`{state: "Completed", result: {video}}`; MiniMax H3 Max instead answers with its
own documented `{task: {status, content: {url}}}` wrapper, decoded separately
and treated as failed unless `status` is exactly `"succeeded"`. The provider
returns `{bytes, format: "mp4"}`; the service returns
`{bytes, costMilliunits, path, format, height, model, width}` on completion.
While the alarm is running, HTTP returns 202 with
`{status: "pending", retryAfterSeconds: 5}`. Retry the same request ID,
destination and settings to recover the retained result. The host chooses the
output path, such as `prints-<requestId>.mp4`; Darkroom adds no output-naming
rule or human-review gate.

### App MEDIA binding

The shared `@fungi.computer/darkroom/server` binding grammar and reply decoder
are used by Hub and standalone Oyster. The internal generation command carries
its image/video kind, stable request ID and App-owned library folder. Hosts
attach the admitted Computer to reference paths, read and fit those references,
and use `createMediaService` for generation, retention, replay and saving.
Guests cannot supply a principal or reference Computer ID.

Image encoding is model-native when `outputFormat` is omitted. An explicit PNG,
JPEG or WebP pin must be supported by the model; the saved result reports its
actual encoding. Catalogs retain reference support declared by the model and
available through that host. Unsupported reference selections are typed
`INVALID_ARGUMENT` settings refusals before dispatch.

Runtime-neutral App definitions import the shared binding schemas from
`@fungi.computer/darkroom/media-binding`; the server entry also re-exports them
for host composition.
