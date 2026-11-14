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
`refusalMessages` for insufficient credit and denied spending. Quotes are
estimates. Your metering owner decides the customer price and settlement.

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

## Bring your own provider and models

A provider owns its model list. The built-in Fungi gateway provider carries
today's catalogue; a host that injects its own `MediaProvider` also supplies
that provider's catalogue, as data decoded with `parseMediaCatalogue`. Darkroom
validates every request against the active provider's catalogue, so `fal-ai/...`
ids are accepted by your provider and refused by the gateway's.

Each entry carries the per-model bounds the validator enforces: prompt length,
dimensions or exact sizes, steps, reference counts, and for video the durations,
resolution/aspect formats and per-second prices. Mark a video model's
`video.provider` as `"host"`: your provider owns that model's wire grammar.

```ts
import {
  parseMediaCatalogue,
  type MediaProvider,
} from "@fungi.computer/darkroom";
import { createMediaService } from "@fungi.computer/darkroom/server";
import { MediaOperationDO } from "@fungi.computer/darkroom/cloudflare";

declare const FAL_KEY: string; // your fal.ai key, from the host environment

// Decoded once; throws MediaSettingsError on a malformed or contradictory entry.
export const falCatalogue = parseMediaCatalogue([
  {
    id: "fal-ai/minimax/hailuo-2.3/standard/image-to-video",
    label: "Hailuo 2.3 Standard",
    kind: "video",
    tier: "draft",
    outputFormats: [],
    maxPromptLength: 2_000,
    sizes: ["1366x768"],
    input: {
      transport: "json",
      dimensions: "own",
      maxDimension: 1366,
      maxDimensionDocumented: false,
      defaultWidth: 1366,
      defaultHeight: 768,
      steps: "fixed",
      maxSteps: null,
      defaultSteps: null,
      referenceField: "image_url",
      maxReferences: 1,
      referenceDimension: null,
      referenceFormat: "png",
    },
    video: {
      minSeconds: 6,
      maxSeconds: 10,
      defaultSeconds: 6,
      durations: [6, 10],
      provider: "host",
      formats: [
        { resolution: "768p", aspectRatio: "16:9", width: 1366, height: 768 },
      ],
      defaultResolution: "768p",
      defaultAspectRatio: "16:9",
      supportsAudio: false,
      defaultGenerateAudio: null,
      referenceRoles: ["first-frame"],
      maxReferenceImages: 0,
      referenceResolutions: [],
      prices: [
        {
          resolution: "768p",
          silentMilliunitsPerSecond: 3_000,
          audioMilliunitsPerSecond: 3_000,
        },
      ],
    },
  },
]);

// Settings arrive already validated against falCatalogue.
export const falProvider: MediaProvider = async (
  settings,
  references,
  signal,
) => {
  const first = references[0];
  if (first === undefined)
    throw new Error("image-to-video needs a first frame");
  const queued = await fetch(`https://queue.fal.run/${settings.model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: settings.prompt,
      duration: String(settings.durationSeconds),
      image_url: `data:image/${first.format};base64,${btoa(String.fromCharCode(...first.bytes))}`,
    }),
    signal: signal ?? null,
  });
  // ...poll the queue, download the MP4 and return it.
  return {
    bytes: new Uint8Array(await (await queued.blob()).arrayBuffer()),
    format: "mp4",
  };
};

// The durable job engine runs your provider from its alarm, so it needs the
// same catalogue.
export class FalMediaOperationDO extends MediaOperationDO {
  protected override mediaProvider() {
    return falProvider;
  }
  protected override mediaCatalogue() {
    return falCatalogue;
  }
}

// In the request path, pass the catalogue and your own quote beside the provider.
const service = createMediaService({
  // scope, operations, metering and destination as in the quick start
  provider: falProvider,
  catalogue: falCatalogue,
  estimate: (settings) => 3_000 * (settings.durationSeconds ?? 6),
  // ...
});
```

`GET /models` lists `falCatalogue`. A request for a model outside it, or
settings outside its bounds, is refused before billing or dispatch. The
gateway's own models are refused by this provider the same way.

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
`error` becomes `message`, and `stage`, `retryable` and optional `provider`
facts stay unchanged. HTTP failures and transport envelopes are separate
representations and do not decode as these outcomes.

Provider facts use Agar's canonical Media grammar: an allowlisted error category
and bounded numeric code, or `result_download` and a native HTTP status. The
provider boundary classifies code `2021` as the optional, closed
`provider.reason: "credits_exhausted"`. On 2026-10-27, a real GPT Image 2 call
from the Prints UI returned
`AiGatewayError: 2021: Insufficient AI Gateway credits`. The original evidence
is `~/Botanical-cto/receipts/prints-e2e/REPORT.md:51` ("Follow-up 2"; no charge
recorded at line 53) and
`~/Botanical-cto/receipts/prints-e2e/gwfix/results.json` (02:01 local; GPT Image
2 call at `2026-10-27T01:01:04.296Z`). The error object contained only
`name: "AiGatewayError"` and `message: "2021: Insufficient AI Gateway credits"`;
no HTTP status was recorded. This is observed provider wording from a real UI
call, not a published guarantee that every Cloudflare `2021` means a zero
balance. Apps consume the typed reason without interpreting provider numbers or
public error prose, and should direct the owner to check AI Gateway credits and
billing rather than infer the account balance. It is separate from the host's
`INSUFFICIENT_CREDIT` Team billing refusal. The durable owner retains those
facts through interruption and replay, including safety refusals, without
retaining the original error message or cause in the failure record. A terminal
provider failure never redispatches the paid attempt. The fresh pre-release
schema replaces the safety-only refusal table; old preview stores require an
explicit host reset, not an automatic migration or dual reader.

See the [generated API](docs/api/README.md) for signatures and host ports. The
Cloudflare entry needs the native Workers type declarations in a TypeScript
host. The other entries use ordinary platform web types.

## Examples

For Workers AI, use `createWorkersAiMediaProvider(env.AI)` from `cloudflare` and
add an `AI` binding to your host. `createImagesReferenceFitter` prepares bounded
reference images through an Images binding, using the selected catalog model
passed to the fitter. Your host authorizes each reference read.

`stripPrivateProvenance(bytes)` from `provenance` removes prompt and lineage
metadata while preserving the AI marker, print ID and image encoding. It returns
bytes, MIME type and filename extension. The public XMP format uses
`https://fungi.computer/ns/provenance/1.0/`.

## Limits

References are bounded to four files and 8 MiB per image. Image-model references
keep a maximum 512-pixel long edge. Video-model frames and references preserve
their aspect ratio and are fitted by the short edge to 320 pixels, growing
smaller inputs when necessary; resolved video references must have a short edge
of at least 320 pixels. Still-image output and public downloads are bounded to
32 MiB. Catalog models may impose tighter limits. Video output has its own 64
MiB provider bound.

The 8 MiB reference budget also applies after transformation: extreme panoramas
can still exceed the encoded-byte budget, even though video references have no
512-pixel long-edge cap. Celld Hub reference fitting requires a
[paired Hub and edge release](../../services/hub-edge/README.md#paired-hub-and-edge-release);
the linked section includes the draft Fungi 0.7.1 release note and mixed-version
failure window.

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

### Audio

Speech and music run through Cloudflare's Unified Billing, so Teams pay Team
credit at provider cost plus the normal markup and no customer key is involved.
The catalog carries `elevenlabs/eleven-multilingual-v2` (the default voice
model), `elevenlabs/eleven-v3` and `elevenlabs/music-v2`, each with
`kind: "audio"` and an `audio` block; every bound and rate comes from the
model's page under `https://developers.cloudflare.com/ai/models/elevenlabs/`.
Cloudflare offers no sound-effects model and no voice listing, so the only voice
is the one its pages list (`JBFqnCBsd6RMkjVDRZzb`), and sound effects, custom
voices and cloned voices are not offered.

Speech takes `prompt` (the spoken text, up to 10,000 characters) and an optional
catalog `voiceId`; music takes `prompt` and `durationSeconds` from 3 through 600
(30 when omitted). Neither takes dimensions, steps, `generateAudio` or
references; `validateMediaGenerationSettings` refuses them rather than dropping
them. Speech is quoted per character (5 or 10 milliunits) and music per second
(250 milliunits). `mediaUnits` bills speech as
`{unit: "audio_character_block", units: ceil(characters / 100)}` and music as
`{unit: "audio_second", units: durationSeconds}`, so a per-character rate is
marked up once per block. Requests ask ElevenLabs for `mp3_44100_128`; the
provider fetches the result URL and returns `{bytes, format: "mp3"}`. Audio runs
through the same durable alarm as video: HTTP returns 202 until the retained MP3
is ready, and the output has no embedded provenance. Hub public sharing does not
cover audio. The MEDIA binding accepts `kind: "audio"` with `prompt`, `voiceId`
or `durationSeconds`, and saves `<libraryPath>/prints-<requestId>.mp3`. The
`/models` listing still carries pictures and video only, because the Agar and
Prints catalog decoders have no audio kind yet; audio models are generated by
id.

Video models declare `video.audioReferences` (`{max, totalSeconds}`, or null).
Only Seedance 2.5 sets it, at 10 clips and 30 seconds, from its Cloudflare input
schema's `reference_audios`. A video selection may carry `audioReferences`
(`[{path}]`); every other model refuses them before admission, and a clip is
never dropped or trimmed. The host supplies authority through
`destination.readAudioReference(reference)`, which returns the raw bytes;
Darkroom parses each clip with music-metadata (mp3, m4a, wav, ogg or opus),
refuses unreadable bytes, and refuses a set whose count exceeds the model's
`max` or whose durations total more than `totalSeconds`, all before billing.
Clips reach the provider as `data:audio/...;base64,...` entries in
`reference_audios`, are retained in the artifacts bucket for the background
alarm like reference images, and are deleted after dispatch. A host that gives
no `readAudioReference` lists `audioReferences: null`. Standalone Oyster reads
clips from the Computer workspace; the Hub Agent host does not read audio
references yet. Parsing pulls in music-metadata, which reads Node built-ins, so
a Worker that runs the Media service needs the `nodejs_compat` flag (the Hub and
Oyster deploy configs set it). The hub-edge provider path only forwards clips
and MP3 output, and does not load the parser.

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
