# Standalone Media backend

This example runs the shared Media Hono service inside a Durable Object. The
forwarding Worker checks a bearer token. The host supplies one R2 bucket through
`createR2MediaDestination`: reference images are read from it and outputs are
saved to it. Each generation uses the same native operation DO and
retained-output code as Fungi. No Hub, Team, Computer, or browser UI is
required.

From the repository root:

```sh
pnpm --filter @fungi.computer/darkroom build
pnpm --filter @fungi.computer/darkroom exec wrangler deploy --dry-run --config examples/standalone/wrangler.jsonc
```

For local serving, create `examples/standalone/.dev.vars` inside this package
with `MEDIA_TOKEN="your-local-token"`, then run:

```sh
pnpm --filter @fungi.computer/darkroom exec wrangler dev --config examples/standalone/wrangler.jsonc
```

The AI binding needs Cloudflare provider access for actual inference. The native
test injects image bytes and does not call a live provider. Local native SQL/R2
proof does not establish hosted AI availability. No deployment or bucket
provisioning is performed by the dry-run command.

Use the bearer token on every request:

- `GET /models` lists supported models. References are read from the `OUTPUTS`
  bucket: put an image at a key, then send
  `"references":[{"computerId":"outputs","path":"<key>"}]` in the settings of a
  model that takes references. `computerId` must equal the host's destination id
  (`outputs`); any other value is refused before the provider is called.
- `POST /generate` accepts `X-Request-Id` and JSON such as
  `{"path":"greenhouse.png","settings":{"model":"@cf/black-forest-labs/flux-1-schnell","prompt":"a greenhouse","width":1024,"height":768,"steps":4}}`.
- `GET /object?key=greenhouse.png` reads the saved bytes.

`path` is an R2 object key. There are no directories to create. The actual image
format is returned by generation; the service does not choose a filename suffix.
For a failed save, resend the same request ID and identical JSON. A retained
output is saved again without another provider call. An unresolved provider call
is not automatically rerun. Use a new request ID for a different generation.

`MEDIA_HOST` is the HTTP host DO; `MEDIA_OPERATION` is the per-request native
operation namespace. `APP_ARTIFACTS` holds retained image bytes, `OUTPUTS` holds
reference images and saved objects, `AI` is the Workers AI binding, and `IMAGES`
is the Images binding that fits references to the selected model. `MEDIA_TOKEN`
is a required secret. The example is a single application with one bearer
identity; adopting it for multiple users requires the host to admit their scope
explicitly.
