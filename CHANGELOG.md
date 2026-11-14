# @fungi.computer/darkroom

## 0.9.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.16.0

## 0.9.0

### Minor Changes

- Changes since 0.8.0:

  - fix(prints): keep the quote test on the full catalog and regenerate Darkroom
    docs after merging #731
  - fix(prints,caps): audio polish from the wired re-review
  - feat(agar,prints): carry audio models, voices and MP3 results through the
    Media contract

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.15.0

## 0.8.0

### Minor Changes

- Changes since 0.7.0:

  - fix(darkroom): regenerate server docs and list picture models in the quote
    test
  - fix(darkroom): keep audio fields off image settings and repin Trellis to the
    Prints catalog
  - fix(darkroom): repair the gate after merging integration
  - fix(darkroom): repin the Prints catalog and templates, guard optional image
    sizes
  - fix(darkroom): drop BYOK-only Eleven Flash and pin the decoder to the live
    answer
  - feat(hub-edge): forward audio output and reference clips to the Media
    provider
  - feat(darkroom): send Seedance 2.5 reference audio clips
  - feat(darkroom): generate speech and music through ElevenLabs on Unified
    Billing

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.14.0

## 0.7.0

### Minor Changes

- Changes since 0.6.0:

  - fix(oyster): satisfy anti-slop in the Oyster price proof
  - fix(hub): fill the agents instructionsUrl in the quote test host; regenerate
    API docs
  - feat(media): price one exact generation through the host
  - fix(darkroom): document the daily meter and regenerate API docs
  - fix(darkroom): keep the gateway video schema; regenerate API docs
  - fix(oyster): explain Cloudflare Images error 9432 and minify the standalone
    Worker
  - feat(prints): add Seedream 5 Pro as an image model
  - feat(darkroom): let a host inject its provider's model catalogue
  - fix(oyster): keep the media env type and check the daily meter object
  - feat(oyster): daily media hard stop with a plain spending-limit message

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.13.0

## 0.6.0

### Minor Changes

- Changes since 0.5.12:

  - fix(darkroom): keep the GPT Image 2 size limits private
  - feat(prints): more image aspect ratios and a Match reference size
  - feat(darkroom): default Seedance generated sound to On
  - fix(darkroom): admit Seedance 2.0 prompts up to the provider's 10,000
    characters
  - feat(darkroom): price Seedance 2.5 at the dashboard rates
  - feat(prints): add Seedance 2.5 to the Darkroom video catalog

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.12.1

## 0.5.12

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.12.0

## 0.5.11

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.11.0

## 0.5.10

### Patch Changes

- Changes since 0.5.9:

  - fix(darkroom): regenerate API docs and the Prints catalog pin for reference
    fields
  - fix(darkroom): fit GPT Image 2 references at 1024 px as WebP with a body
    bound
  - fix(darkroom): stay quiet when provenance cannot be embedded in MP4 or GIF

- Updated dependencies
  - @fungi.computer/agar@0.10.1

## 0.5.9

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.10.0

## 0.5.8

### Patch Changes

- Changes since 0.5.7:

  - fix(prints): download C2PA-signed images unchanged

## 0.5.7

### Patch Changes

- Changes since 0.5.6:

  - fix(oyster): run trial Git storage in Wrangler's local simulator

## 0.5.6

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.9.1

## 0.5.5

### Patch Changes

- Changes since 0.5.4:

  - fix(docs): build Shiitake before darkroom's API docs; record Vishnu docs
    exclusion

- Updated dependencies
  - @fungi.computer/agar@0.9.0

## 0.5.4

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.8.0

## 0.5.3

### Patch Changes

- @fungi.computer/agar@0.7.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.7.2

## 0.5.1

### Patch Changes

- @fungi.computer/agar@0.7.1

## 0.5.0

### Minor Changes

- Changes since 0.4.1:

  - feat(prints): share one Print with a public, read-only link

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.7.0

## 0.4.1

### Patch Changes

- Changes since 0.4.0:

  - fix(billing): remove cumulative caps on funded usage

- @fungi.computer/agar@0.6.1

## 0.4.0

### Minor Changes

- Changes since 0.3.1:

  - fix(darkroom): retain interruption cleanup failures
  - fix(darkroom): fit video references by their short edge
  - fix(prints): resume video attempts on reopen with honest progress
  - fix(prints): map provider failures to one error toast
  - feat(prints): add authorized Agent media parity
  - fix(prints): consume typed credits refusals and admitted media kind
  - fix(darkroom): retain a typed provider credits exhaustion reason
  - fix(prints): merge video recovery and charge-safe failures
  - fix(prints): repair Agent parity gate regressions
  - fix(prints): reconcile Agent media parity with integration

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.5.0

## 0.3.0

### Minor Changes

- Changes since 0.2.1:

  - fix(darkroom): route only gateway-compatible media inputs through AI Gateway
  - fix(prints): seat the video controls in the composer row
  - feat(prints): choose video frame roles and audio from the model's documented
    capabilities
  - feat(prints): widescreen presets within a documented maximum
  - feat(prints): show the aspect ratio beside each image size
  - fix(darkroom): bill GPT Image 2 references at the image input rate
  - feat(prints): reference images per model, GPT Image 2 takes up to 16
  - feat(prints): enforce a documented prompt limit per model

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.4.0

## 0.2.1

### Patch Changes

- @fungi.computer/agar@0.3.1

## 0.2.0

### Minor Changes

- Changes since 0.1.0:

  - feat(stranger): typecheck each public entry in its own environment
  - fix: cover Computer and Oyster packed dependency closures
  - fix(media): expose diagnostic grammar to API document consumers
  - fix(media): preserve safe provider diagnostics through replay
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/agar@0.3.0
  - @fungi.computer/cairn@0.1.0

## 0.1.0

### Minor Changes

- Changes since 0.0.1:

  - perf(darkroom): build schemas on first use, not at import
  - feat(oyster): public release 0.1.0

### Patch Changes

- Updated dependencies
  - @fungi.computer/agar@0.2.0

## 0.0.1

### Patch Changes

- Initial public release of @fungi.computer/darkroom.
- Updated dependencies
  - @fungi.computer/agar@0.1.0
