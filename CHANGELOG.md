# @fungi.computer/darkroom

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
