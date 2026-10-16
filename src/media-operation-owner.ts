import { mediaRequestedImageFormatSchema } from "./model-catalog.js";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import {
  mediaGenerationSettingsSchema,
  validateMediaGenerationSettings,
  type MediaGenerationSettings,
} from "./index.js";
import { z } from "zod";
import type {
  MediaOperationContext,
  MediaOperationBucket,
} from "./media-operation-storage.js";
import type { MediaProvider, MediaReferenceBytes } from "./index.js";
import { reportCatchFailure } from "./failure.js";
import { MediaSafetyFilterRefusal } from "./execution-error.js";

const providerRefusalSchema = z.literal("safety_filter_refused");

const ids = defineIdFamily({
  family: "hub-media-operation",
  version: 1,
  kinds: { lease: { prefix: "media_lease" } },
});

const text = z.string().min(1).max(256);
const path = z.string().min(1).max(1_024);
const referenceMetadataSchema = z.lazy(() =>
  z.object({
    format: z.enum(["png", "jpeg", "gif", "webp"]),
    width: z.coerce.number().int().positive(),
    height: z.coerce.number().int().positive(),
  }),
);
const referenceKey = (operationId: string, index: number) =>
  `media-reference/v1/${operationId}/${String(index)}`;

/** Fixed generation destination captured before provider dispatch. */
export const mediaOperationDestinationSchema = z.lazy(() =>
  z.strictObject({
    /** Host-admitted destination or reference identity. */
    computerId: text,
    /** Fixed relative path in the admitted destination. */
    path,
    /** Optional verified image encoding pin. */
    outputFormat: mediaRequestedImageFormatSchema.optional(),
  }),
);
/** Normalized generation and its fixed destination, captured for exact replay. */
export type MediaOperationRequest = MediaGenerationSettings &
  z.output<typeof mediaOperationDestinationSchema>;

/** Decode host namespace and owner identity. */
export const mediaOperationCoordinatesSchema = z.strictObject({
  /** Host isolation namespace. */
  namespace: text,
  /** Host owner within the namespace. */
  owner: text,
});
/** Host-owned namespace and owner identity for one durable operation. */
export type MediaOperationCoordinates = z.output<
  typeof mediaOperationCoordinatesSchema
>;

/** Decode durable generation, save and settlement states. */
export const mediaOperationStateSchema = z.enum({
  /** Host identity and input captured. */
  admitted: "admitted",
  /** Exclusive input preparation lease. */
  estimating: "estimating",
  /** Provider dispatch admitted; output not yet retained. */
  generating: "generating",
  /** Generated output retained; destination save in progress. */
  writing: "writing",
  /** Destination committed; idempotent host settlement pending. */
  charging: "charging",
  /** Unmetered generation and destination write completed with a quote. */
  written: "written",
  /** Generation and settlement completed. */
  succeeded: "succeeded",
  /** Provider execution ended without a reusable output. */
  interrupted: "interrupted",
});
/** Durable generation, save and settlement states. */
export type MediaOperationState = z.output<typeof mediaOperationStateSchema>;

/** Decode retained or saved output size and encoding. */
export const mediaImageSchema = z.lazy(() =>
  z.strictObject({
    /** Output byte length. */
    bytes: z.number().int().positive(),
    /** Actual output encoding. */
    format: text,
  }),
);
/** Byte length and encoding of generated or saved output. */
export type MediaImage = z.output<typeof mediaImageSchema>;
const retainedFormatSchema = z.lazy(() =>
  z
    .enum(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4"])
    .transform(
      (mime) =>
        ({
          "image/png": "png",
          "image/jpeg": "jpeg",
          "image/gif": "gif",
          "image/webp": "webp",
          "video/mp4": "mp4",
        })[mime],
    ),
);
const outputSchema = z.lazy(() =>
  z.strictObject({
    key: text,
    version: text,
    bytes: z.number().int().positive(),
    format: text,
  }),
);
type MediaOutput = z.output<typeof outputSchema>;

/** Decode the settled receipt, including the host-admitted customer price. */
export const mediaOperationResultSchema = z.lazy(() =>
  z.strictObject({
    /** Durable operation identifier. */
    generationId: text,
    /** Output byte length. */
    bytes: z.number().int().positive(),
    /** Actual output encoding. */
    format: text,
    /** Admitted price in milliunits, where 1 cent is 1,000 milliunits. */
    costMilliunits: z.number().int().nonnegative(),
  }),
);
/** Settled generation receipt with the host-admitted customer price. */
export type MediaOperationResult = z.output<typeof mediaOperationResultSchema>;

type OperationRecord = Readonly<{
  operationId: string;
  requestId: string;
  actorUserId: string;
  namespace: string;
  owner: string;
  fingerprint: string;
  input: MediaOperationRequest;
  state: MediaOperationState;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  estimatedCostMilliunits: number | null;
  image: MediaImage | null;
  output: MediaOutput | null;
  writeReceipt: string | null;
  result: MediaOperationResult | null;
  createdAt: number;
  updatedAt: number;
}>;

/** The only operation shape safe to return outside the owner. */
export type MediaOperationProjection = Readonly<{
  /** Durable object name identifying this operation. */
  operationId: string;
  /** Retry identity chosen by the caller. */
  requestId: string;
  /** Host isolation namespace. */
  namespace: string;
  /** Host owner within the namespace. */
  owner: string;
  /** Current durable lifecycle state. */
  state: MediaOperationState;
  /** Terminal format mismatch after provider execution. */
  spentFailure: "output_format_mismatch" | null;
  /** Definitive provider refusal with no delivered or billable output. */
  providerRefusal: "safety_filter_refused" | null;
  /** Pinned host price or unmetered quote. */
  estimatedCostMilliunits: number | null;
  /** Retained or saved image metadata. */
  image: MediaImage | null;
  /** Settled receipt when generation and billing completed. */
  result: MediaOperationResult | null;
  /** Admission timestamp in milliseconds since the epoch. */
  createdAt: number;
  /** Last transition timestamp in milliseconds since the epoch. */
  updatedAt: number;
}>;

/** An admission or claim decision with a safe operation projection. */
export type MediaOperationDecision = Readonly<{
  /** Admission or claim outcome. */
  kind:
    | "admitted"
    | "conflict"
    | "replayed"
    | "claimed"
    | "pending"
    | "succeeded"
    | "interrupted";
  /** Safe persisted projection for this decision. */
  operation: MediaOperationProjection;
  /** Exclusive dispatch or save lease when claimed. */
  leaseId?: string;
}>;

/** Scoped inactivity observation made before destructive erasure. */
export type MediaErasurePreflight = Readonly<{
  /** Namespace supplied by the host's resource roster. */
  namespace: string;
  /** Named operation request supplied by that roster. */
  requestId: string;
  /** Whether durable erasure has already completed. */
  erased: boolean;
}>;

/** Evidence that retained output, SQL and alarms were erased. */
export type MediaErasureReadback = Readonly<{
  /** True only after all local data and retained output are absent. */
  clear: boolean;
}>;

/** Retained output projection, or a terminal spent format refusal. */
export type MediaRetentionResult =
  | MediaOperationProjection
  | Readonly<{
      /** Provider execution finished with an unusable pinned format. */
      kind: "refused";
      /** Stable mismatch reason recorded before settlement. */
      code: "output_format_mismatch";
    }>;

class MediaOperationError extends Error {
  constructor(
    /** Bounded refusal or failure reason. */
    readonly code:
      | "invalid_input"
      | "conflict"
      | "not_found"
      | "partial_init"
      | "lease_lost",
    options?: ErrorOptions,
  ) {
    super(`Media operation ${code}`, options);
    this.name = "MediaOperationError";
  }
}

/** Optional host facts that pin a namespace before operation admission. */
export type MediaOperationHooks = Readonly<{
  /** Read the namespace already owned by host-local facts, or null when unbound. */
  namespace?: () => string | null;
}>;

/** Retained-output storage supplied by the host. */
export type MediaOperationEnvironment = Readonly<{
  /** Bucket retaining exact output and background reference bytes. */
  APP_ARTIFACTS: MediaOperationBucket;
}>;

/** Stored media type for an output format. */
const outputMime = (format: string) =>
  format === "mp4" ? "video/mp4" : `image/${format}`;
const operationRowSchema = z.lazy(() =>
  z.object({
    operation_id: z.string(),
    request_id: z.string(),
    actor_user_id: z.string(),
    team_id: z.string(),
    installation_id: z.string(),
    fingerprint: z.string(),
    input: z.string(),
    state: mediaOperationStateSchema,
    lease_id: z.string().nullable(),
    lease_expires_at: z.number().nullable(),
    estimated_cost_milliunits: z.number().nullable(),
    image: z.string().nullable(),
    output: z.string().nullable(),
    write_receipt: z.string().nullable(),
    result: z.string().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
    background: z.number(),
    dispatched_at: z.number().nullable(),
  }),
);
type OperationRow = z.output<typeof operationRowSchema>;

const schemaStatements = [
  `CREATE TABLE hub_media_operation (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    operation_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE,
    actor_user_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    input TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('admitted','estimating','generating','writing','charging','written','succeeded','interrupted')),
    lease_id TEXT,
    lease_expires_at INTEGER,
    estimated_cost_milliunits INTEGER,
    image TEXT,
    output TEXT,
    write_receipt TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    background INTEGER NOT NULL DEFAULT 0,
    dispatched_at INTEGER
  ) STRICT`,
  "CREATE TABLE hub_media_spent_failure (singleton INTEGER PRIMARY KEY CHECK(singleton=1),code TEXT NOT NULL CHECK(code='output_format_mismatch')) STRICT",
  "CREATE TABLE hub_media_provider_refusal (singleton INTEGER PRIMARY KEY CHECK(singleton=1),code TEXT NOT NULL CHECK(code='safety_filter_refused')) STRICT",
] as const;

function fingerprint(input: MediaOperationRequest): string {
  return JSON.stringify(input);
}

const objectSchema = z.lazy(() => z.record(z.string(), z.unknown()));

function decodeStoredRequest(serialized: string): MediaOperationRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (cause) {
    throw new MediaOperationError("partial_init", { cause });
  }
  const object = objectSchema.safeParse(raw);
  if (!object.success) throw new MediaOperationError("partial_init");
  const destination = mediaOperationDestinationSchema.safeParse({
    computerId: object.data.computerId,
    path: object.data.path,
    outputFormat: object.data.outputFormat,
  });
  if (!destination.success) throw new MediaOperationError("partial_init");
  const generation = { ...object.data };
  delete generation.computerId;
  delete generation.path;
  delete generation.outputFormat;
  const parsedGeneration = mediaGenerationSettingsSchema.safeParse(generation);
  if (!parsedGeneration.success) throw new MediaOperationError("partial_init");
  let settings: MediaGenerationSettings;
  try {
    settings = validateMediaGenerationSettings(parsedGeneration.data);
  } catch (cause) {
    throw new MediaOperationError("partial_init", { cause });
  }
  return Object.freeze({
    ...settings,
    computerId: destination.data.computerId,
    path: destination.data.path,
    outputFormat: destination.data.outputFormat,
  });
}

/** Own exact replay, dispatch leases, retained output and save recovery in SQL and object storage. */
export class MediaOperationOwner {
  private erased = false;
  private readonly leaseMs = 5 * 60 * 1_000;
  /**
   * A background (video) generation holds its lease past the 15-minute alarm
   * wall-clock limit, so a live alarm is never mistaken for a lost one.
   */
  private readonly backgroundLeaseMs = 20 * 60 * 1_000;
  private initialized = false;

  /**
   * The host supplies the provider for background alarm generations.
   */
  protected mediaProvider(): MediaProvider | undefined {
    return this.provider?.();
  }

  constructor(
    private readonly ctx: MediaOperationContext,
    private readonly env: MediaOperationEnvironment,
    private readonly provider?: () => MediaProvider | undefined,
    private readonly hooks: MediaOperationHooks = {},
  ) {
    void ctx.blockConcurrencyWhile(async () => {
      if (await ctx.storage.isErased()) {
        this.erased = true;
        return;
      }
      this.ensureSchema();
    });
  }

  private ensureSchema(): void {
    if (this.erased) throw new MediaOperationError("not_found");
    if (this.initialized) return;
    const existing = this.ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='hub_media_operation'",
      )
      .toArray()[0];
    if (existing === undefined) {
      for (const statement of schemaStatements)
        this.ctx.storage.sql.exec(statement);
    } else {
      // Pre-launch stores use the current fresh schema or get reset by the host.
      // Missing refusal facts are not healed or incrementally migrated here.
      this.ctx.storage.sql.exec(
        "SELECT code FROM hub_media_provider_refusal LIMIT 0",
      );
    }
    this.initialized = true;
  }

  private decodeJson<T>(value: string, schema: z.ZodType<T>): T {
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch (cause) {
      throw new MediaOperationError("partial_init", { cause });
    }
    const parsed = schema.safeParse(parsedValue);
    if (!parsed.success) throw new MediaOperationError("partial_init");
    return parsed.data;
  }

  private decode(row: OperationRow): OperationRecord {
    const operationId = text.safeParse(row.operation_id);
    const requestId = text.safeParse(row.request_id);
    const actor = text.safeParse(row.actor_user_id);
    const coordinates = mediaOperationCoordinatesSchema.safeParse({
      namespace: row.team_id,
      owner: row.installation_id,
    });
    if (!operationId.success || !requestId.success || !actor.success)
      throw new MediaOperationError("partial_init");
    if (
      !coordinates.success ||
      !mediaOperationStateSchema.safeParse(row.state).success
    )
      throw new MediaOperationError("partial_init");
    return Object.freeze({
      operationId: operationId.data,
      requestId: requestId.data,
      actorUserId: actor.data,
      namespace: coordinates.data.namespace,
      owner: coordinates.data.owner,
      fingerprint: row.fingerprint,
      input: decodeStoredRequest(row.input),
      state: row.state,
      leaseId: row.lease_id,
      leaseExpiresAt: row.lease_expires_at,
      estimatedCostMilliunits: row.estimated_cost_milliunits,
      image:
        row.image === null
          ? null
          : this.decodeJson(row.image, mediaImageSchema),
      output:
        row.output === null ? null : this.decodeJson(row.output, outputSchema),
      writeReceipt: row.write_receipt,
      result:
        row.result === null
          ? null
          : this.decodeJson(row.result, mediaOperationResultSchema),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private project(record: OperationRecord): MediaOperationProjection {
    const failure = this.ctx.storage.sql
      .exec("SELECT code FROM hub_media_spent_failure WHERE singleton=1")
      .toArray()[0];
    const spentFailure =
      failure === undefined
        ? null
        : z
            .strictObject({
              code: z.literal("output_format_mismatch"),
            })
            .parse(failure).code;
    const refusal = this.ctx.storage.sql
      .exec("SELECT code FROM hub_media_provider_refusal WHERE singleton=1")
      .toArray()[0];
    const providerRefusal =
      refusal === undefined
        ? null
        : z.strictObject({ code: providerRefusalSchema }).parse(refusal).code;
    return Object.freeze({
      operationId: record.operationId,
      requestId: record.requestId,
      namespace: record.namespace,
      owner: record.owner,
      state: record.state,
      spentFailure,
      providerRefusal,
      estimatedCostMilliunits: record.estimatedCostMilliunits,
      image: record.image,
      result: record.result,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private readRecord(): OperationRecord | null {
    if (this.erased) return null;
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM hub_media_operation WHERE singleton=1")
      .toArray()[0];
    if (row === undefined) return null;
    const parsed = operationRowSchema.safeParse(row);
    if (!parsed.success)
      throw new MediaOperationError("partial_init", { cause: parsed.error });
    return this.decode(parsed.data);
  }

  /** Read the safe persisted operation projection, or null before admission or after erasure. */
  public read(): MediaOperationProjection | null {
    const record = this.readRecord();
    return record === null ? null : this.project(record);
  }

  /** Check host namespace, request identity and inactivity before erasure. */
  public preflightErasure(
    namespace: string,
    requestId: string,
  ): MediaErasurePreflight {
    if (this.ctx.id.name !== `media:${requestId}`)
      throw new Error("Media erasure address mismatch");
    if (this.erased) return { namespace, requestId, erased: true };
    const record = this.readRecord();
    const ownerNamespace =
      record?.namespace ?? this.hooks.namespace?.() ?? null;
    if (
      (ownerNamespace !== null && ownerNamespace !== namespace) ||
      (record !== null && record.requestId !== requestId)
    )
      throw new Error("Media erasure scope mismatch");
    if (
      record !== null &&
      ["estimating", "generating", "writing", "charging"].includes(record.state)
    )
      throw new Error("Media operation is still active");
    return { namespace, requestId, erased: false };
  }

  /** Erase inactive output and local storage, then retain the durable erasure marker. */
  public async erase(namespace: string, requestId: string) {
    if (this.erased) return this.readErasure();
    this.preflightErasure(namespace, requestId);
    // The operation's immutable output key is owned by this DO identity.
    await this.env.APP_ARTIFACTS.delete(this.erasureOutputKey());
    if (await this.env.APP_ARTIFACTS.head(this.erasureOutputKey()))
      throw new Error("Media output erasure readback incomplete");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.markErased();
    this.erased = true;
    return this.readErasure();
  }

  /** Read back empty SQL, alarm and retained output with the durable erasure marker. */
  public async readErasure(): Promise<MediaErasureReadback> {
    const keys = await this.ctx.storage.listKeys();
    const tables = this.ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();
    return {
      clear:
        keys.length === 1 &&
        keys[0] === "botanical:erased" &&
        (await this.ctx.storage.isErased()) &&
        tables.length === 0 &&
        (await this.ctx.storage.getAlarm()) === null &&
        (await this.env.APP_ARTIFACTS.head(this.erasureOutputKey())) === null,
    };
  }

  private erasureOutputKey() {
    const name = this.ctx.id.name;
    if (name === undefined)
      throw new Error("Media operation identity unavailable");
    return `media-output/v1/${name}`;
  }

  private requireRecord(): OperationRecord {
    const record = this.readRecord();
    if (record === null) throw new MediaOperationError("not_found");
    return record;
  }

  private update(
    input: Readonly<{
      expectedState: MediaOperationState;
      expectedLeaseId: string | null;
      /** Current durable lifecycle state. */
      state: MediaOperationState;
      /** Exclusive generation or save lease identifier. */
      leaseId: string | null;
      /** Lease expiry in milliseconds since the epoch. */
      leaseExpiresAt: number | null;
      /** Pinned host price or unmetered quote. */
      estimatedCostMilliunits: number | null;
      /** Retained or saved image size and encoding. */
      image: MediaImage | null;
      /** Exact retained provider output. */
      output: MediaOutput | null;
      writeReceipt: string | null;
      /** Settled generation receipt. */
      result: MediaOperationResult | null;
      allowExpired?: boolean;
    }>,
  ): OperationRecord {
    const timestamp = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE hub_media_operation SET state=?,lease_id=?,lease_expires_at=?,estimated_cost_milliunits=?,image=?,output=?,write_receipt=?,result=?,updated_at=? WHERE singleton=1 AND state=? AND lease_id IS ? AND (lease_id IS NULL OR ?=1 OR lease_expires_at>?)`,
      input.state,
      input.leaseId,
      input.leaseExpiresAt,
      input.estimatedCostMilliunits,
      input.image === null ? null : JSON.stringify(input.image),
      input.output === null ? null : JSON.stringify(input.output),
      input.writeReceipt,
      input.result === null ? null : JSON.stringify(input.result),
      timestamp,
      input.expectedState,
      input.expectedLeaseId,
      input.allowExpired === true ? 1 : 0,
      timestamp,
    );
    const changed = z
      .object({ changes: z.number().int().nonnegative() })
      .parse(
        this.ctx.storage.sql.exec("SELECT changes() AS changes").toArray()[0],
      ).changes;
    if (changed !== 1) throw new MediaOperationError("lease_lost");
    const updated = this.readRecord();
    if (updated === null) throw new MediaOperationError("partial_init");
    return updated;
  }

  private transition(
    leaseId: string,
    expectedState: MediaOperationState,
    state: MediaOperationState,
    values: Readonly<{
      /** Pinned host price or unmetered quote. */
      estimatedCostMilliunits: number | null;
      /** Retained or saved image size and encoding. */
      image: MediaImage | null;
      /** Exact retained provider output. */
      output: MediaOutput | null;
      writeReceipt: string | null;
      /** Settled generation receipt. */
      result: MediaOperationResult | null;
    }>,
  ): MediaOperationProjection {
    return this.ctx.storage.transactionSync(() => {
      const record = this.requireRecord();
      if (record.state !== expectedState || record.leaseId !== leaseId)
        throw new MediaOperationError("lease_lost");
      return this.project(
        this.update({
          expectedState,
          expectedLeaseId: leaseId,
          state,
          leaseId,
          leaseExpiresAt: Date.now() + this.leaseMs,
          ...values,
        }),
      );
    });
  }

  /** Capture immutable host identity and input, replaying exact requests and refusing changed input. */
  public admit(
    actorUserId: string,
    coordinatesInput: MediaOperationCoordinates,
    requestId: string,
    input: MediaOperationRequest,
  ): MediaOperationDecision {
    const actor = text.safeParse(actorUserId);
    const coordinates =
      mediaOperationCoordinatesSchema.safeParse(coordinatesInput);
    const requestIdentifier = text.safeParse(requestId);
    if (!actor.success || !coordinates.success)
      throw new MediaOperationError("invalid_input");
    if (!requestIdentifier.success)
      throw new MediaOperationError("invalid_input");
    const requestFingerprint = fingerprint(input);
    return this.ctx.storage.transactionSync(() => {
      this.ensureSchema();
      const prior = this.readRecord();
      if (prior !== null) {
        if (
          prior.requestId !== requestIdentifier.data ||
          prior.actorUserId !== actor.data ||
          prior.namespace !== coordinates.data.namespace ||
          prior.owner !== coordinates.data.owner ||
          prior.fingerprint !== requestFingerprint
        )
          return {
            kind: "conflict",
            operation: this.project(prior),
          };
        return {
          kind: "replayed",
          operation: this.project(prior),
        };
      }
      const namespace = this.hooks.namespace?.() ?? null;
      if (namespace !== null && namespace !== coordinates.data.namespace)
        throw new MediaOperationError("conflict");
      const operationId = text.parse(this.ctx.id.name);
      const timestamp = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO hub_media_operation (singleton,operation_id,request_id,actor_user_id,team_id,installation_id,fingerprint,input,state,lease_id,lease_expires_at,estimated_cost_milliunits,image,output,write_receipt,result,created_at,updated_at) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        operationId,
        requestIdentifier.data,
        actor.data,
        coordinates.data.namespace,
        coordinates.data.owner,
        requestFingerprint,
        JSON.stringify(input),
        "admitted",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        timestamp,
        timestamp,
      );
      const admitted = this.requireRecord();
      return {
        kind: "admitted",
        operation: this.project(admitted),
      };
    });
  }

  /** Claim a safe dispatch or save lease, recovering retained output without redispatching inference. */
  public async claim(): Promise<MediaOperationDecision> {
    const observed = this.requireRecord();
    // R2 may have committed the exact output before SQL recorded its receipt.
    // Inspect it only after generation's lease expires; never redispatch generation.
    const retained =
      observed.state === "generating" &&
      observed.leaseExpiresAt !== null &&
      observed.leaseExpiresAt <= Date.now()
        ? await this.env.APP_ARTIFACTS.head(
            `media-output/v1/${observed.operationId}`,
          )
        : undefined;
    return this.ctx.storage.transactionSync(() => {
      const record = this.requireRecord();
      if (record.state === "succeeded" || record.state === "interrupted")
        return {
          kind: record.state,
          operation: this.project(record),
        };
      if (record.state === "written")
        return {
          kind: "succeeded",
          operation: this.project(record),
        };
      // Another claimant or the original worker may have committed while R2 was read.
      if (
        record.state !== observed.state ||
        record.leaseId !== observed.leaseId
      )
        return {
          kind: "pending",
          operation: this.project(record),
        };
      const timestamp = Date.now();
      if (
        record.leaseId !== null &&
        (record.leaseExpiresAt === null || record.leaseExpiresAt > timestamp)
      )
        return {
          kind: "pending",
          operation: this.project(record),
        };

      let output = record.output;
      if (record.state === "generating" && retained != null) {
        output = outputSchema.parse({
          key: retained.key,
          version: retained.version,
          bytes: retained.size,
          format: retainedFormatSchema.parse(
            retained.httpMetadata?.contentType,
          ),
        });
      }
      if (
        (record.state === "writing" || record.state === "generating") &&
        output !== null
      ) {
        const leaseId = ids.lease.generate();
        const claimed = this.update({
          expectedState: record.state,
          expectedLeaseId: record.leaseId,
          allowExpired: true,
          state: "writing",
          leaseId,
          leaseExpiresAt: timestamp + this.leaseMs,
          estimatedCostMilliunits: record.estimatedCostMilliunits,
          image: {
            bytes: output.bytes,
            format: output.format,
          },
          output,
          writeReceipt: null,
          result: null,
        });
        return {
          kind: "claimed",
          operation: this.project(claimed),
          leaseId,
        };
      }
      if (record.state === "charging") {
        const leaseId = ids.lease.generate();
        const claimed = this.update({
          expectedState: record.state,
          expectedLeaseId: record.leaseId,
          allowExpired: true,
          state: "charging",
          leaseId,
          leaseExpiresAt: timestamp + this.leaseMs,
          estimatedCostMilliunits: record.estimatedCostMilliunits,
          image: record.image,
          output: record.output,
          writeReceipt: record.writeReceipt,
          result: null,
        });
        return {
          kind: "claimed",
          operation: this.project(claimed),
          leaseId,
        };
      }
      if (record.state === "admitted" || record.state === "estimating") {
        const leaseId = ids.lease.generate();
        const claimed = this.update({
          expectedState: record.state,
          expectedLeaseId: record.leaseId,
          allowExpired: true,
          state: "estimating",
          leaseId,
          leaseExpiresAt: timestamp + this.leaseMs,
          estimatedCostMilliunits: null,
          image: null,
          output: null,
          writeReceipt: null,
          result: null,
        });
        return {
          kind: "claimed",
          operation: this.project(claimed),
          leaseId,
        };
      }
      const interrupted = this.update({
        expectedState: record.state,
        expectedLeaseId: record.leaseId,
        allowExpired: true,
        state: "interrupted",
        leaseId: null,
        leaseExpiresAt: null,
        estimatedCostMilliunits: record.estimatedCostMilliunits,
        image: record.image,
        output: record.output,
        writeReceipt: record.writeReceipt,
        result: null,
      });
      return {
        kind: "interrupted",
        operation: this.project(interrupted),
      };
    });
  }

  /** Pin the admitted price and begin the generation lease. */
  public recordEstimate(leaseId: string, costMilliunits: number) {
    if (!Number.isSafeInteger(costMilliunits) || costMilliunits < 0)
      throw new MediaOperationError("invalid_input");
    return this.transition(leaseId, "estimating", "generating", {
      estimatedCostMilliunits: costMilliunits,
      image: null,
      output: null,
      writeReceipt: null,
      result: null,
    });
  }

  /**
   * Hand a long (video) generation to this owner's alarm. The caller's request
   * returns at once; the alarm dispatches the provider exactly once, retains
   * the output, and releases the lease so a later retry saves and charges it.
   */
  public async dispatchInBackground(
    leaseId: string,
    references: readonly MediaReferenceBytes[],
  ): Promise<MediaOperationProjection> {
    const record = this.requireRecord();
    if (record.state !== "generating" || record.leaseId !== leaseId)
      throw new MediaOperationError("lease_lost");
    for (const [index, reference] of references.entries()) {
      await this.env.APP_ARTIFACTS.put(
        referenceKey(record.operationId, index),
        reference.bytes,
        {
          customMetadata: {
            format: reference.format,
            width: String(reference.width),
            height: String(reference.height),
          },
        },
      );
    }
    const timestamp = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE hub_media_operation SET background=1, lease_expires_at=?, updated_at=? WHERE singleton=1 AND state='generating' AND lease_id=?",
      timestamp + this.backgroundLeaseMs,
      timestamp,
      leaseId,
    );
    await this.ctx.storage.setAlarm(timestamp);
    return this.project(this.requireRecord());
  }

  /** Run a background generation once; a retried alarm never redispatches. */
  public async alarm(): Promise<void> {
    if (this.erased) return;
    this.ensureSchema();
    const raw = this.ctx.storage.sql
      .exec("SELECT * FROM hub_media_operation WHERE singleton=1")
      .toArray()[0];
    if (raw === undefined) return;
    const parsed = operationRowSchema.safeParse(raw);
    if (!parsed.success)
      throw new MediaOperationError("partial_init", { cause: parsed.error });
    const row = parsed.data;
    if (row.state !== "generating" || row.background !== 1) return;
    const record = this.decode(row);
    const leaseId = record.leaseId;
    if (leaseId === null) return;
    if (row.dispatched_at !== null) {
      // A previous alarm dispatched and then died: never call the provider
      // again. Recovery (claim) retains any committed output after the lease.
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE hub_media_operation SET dispatched_at=? WHERE singleton=1",
      Date.now(),
    );
    const provider = this.mediaProvider();
    let output: Readonly<{
      bytes: Uint8Array;
      format: string;
    }>;
    try {
      if (provider === undefined) throw new Error("Media host has no provider");
      const references = await Promise.all(
        (record.input.references ?? []).map(async (_reference, index) => {
          const object = await this.env.APP_ARTIFACTS.get(
            referenceKey(record.operationId, index),
          );
          if (object === null)
            throw new Error("Media reference is unavailable");
          const metadata = referenceMetadataSchema.parse(object.customMetadata);
          return {
            ...metadata,
            bytes: new Uint8Array(await object.arrayBuffer()),
          };
        }),
      );
      // The captured request includes destination authority; providers receive settings only.
      const settings = validateMediaGenerationSettings(
        mediaGenerationSettingsSchema.strip().parse(record.input),
      );
      output = await provider(
        settings,
        references,
        undefined,
        record.input.outputFormat,
      );
    } catch (cause) {
      reportCatchFailure("media-operation-provider", cause);
      // Nothing was delivered; the next retry sees interrupted and releases
      // the billing hold at zero units.
      try {
        this.interruptGeneration(
          leaseId,
          cause instanceof MediaSafetyFilterRefusal
            ? "safety_filter_refused"
            : undefined,
        );
      } catch (cause) {
        reportCatchFailure("media-operation-interrupt", cause);
        /* A recovery claim already ended this lease. */
      }
      return;
    }
    await this.recordGenerated(leaseId, output.bytes, output.format);
    await Promise.all(
      (record.input.references ?? []).map((_reference, index) =>
        this.env.APP_ARTIFACTS.delete(referenceKey(record.operationId, index)),
      ),
    ).catch((cause: unknown) => {
      reportCatchFailure("media-reference-cleanup", cause);
    });
    // Release the lease: the next retry of this request claims the save.
    this.ctx.storage.sql.exec(
      "UPDATE hub_media_operation SET lease_id=NULL, lease_expires_at=NULL WHERE singleton=1 AND state='writing' AND lease_id=?",
      leaseId,
    );
  }

  /** An aborted in-flight provider call is terminal for this request ID. */
  public interruptGeneration(
    leaseId: string,
    refusalInput?: NonNullable<MediaOperationProjection["providerRefusal"]>,
  ): MediaOperationProjection {
    const refusal = providerRefusalSchema.optional().parse(refusalInput);
    const record = this.requireRecord();
    if (record.state !== "generating" || record.leaseId !== leaseId)
      throw new MediaOperationError("lease_lost");
    return this.ctx.storage.transactionSync(() => {
      const interrupted = this.update({
        expectedState: "generating",
        expectedLeaseId: leaseId,
        state: "interrupted",
        leaseId: null,
        leaseExpiresAt: null,
        estimatedCostMilliunits: record.estimatedCostMilliunits,
        image: null,
        output: null,
        writeReceipt: null,
        result: null,
      });
      if (refusal !== undefined)
        this.ctx.storage.sql.exec(
          "INSERT INTO hub_media_provider_refusal(singleton,code) VALUES(1,?)",
          refusal,
        );
      return this.project(interrupted);
    });
  }

  /** Retain immutable provider output before making the save state visible. */
  public async recordGenerated(
    leaseId: string,
    bytes: Uint8Array,
    formatInput: string,
  ): Promise<MediaRetentionResult> {
    const image = mediaImageSchema.safeParse({
      bytes: bytes.byteLength,
      format: formatInput,
    });
    if (!image.success) throw new MediaOperationError("invalid_input");
    const record = this.requireRecord();
    if (record.state !== "generating" || record.leaseId !== leaseId)
      throw new MediaOperationError("lease_lost");
    if (
      record.input.outputFormat !== undefined &&
      image.data.format !== record.input.outputFormat
    ) {
      this.ctx.storage.transactionSync(() => {
        this.update({
          expectedState: "generating",
          expectedLeaseId: leaseId,
          state: "interrupted",
          leaseId: null,
          leaseExpiresAt: null,
          estimatedCostMilliunits: record.estimatedCostMilliunits,
          image: null,
          output: null,
          writeReceipt: null,
          result: null,
        });
        this.ctx.storage.sql.exec(
          "INSERT INTO hub_media_spent_failure(singleton,code) VALUES(1,'output_format_mismatch')",
        );
      });
      return {
        kind: "refused",
        code: "output_format_mismatch",
      } as const;
    }
    const key = `media-output/v1/${record.operationId}`;
    const stored = await this.env.APP_ARTIFACTS.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: outputMime(image.data.format) },
    });
    if (stored === null) throw new MediaOperationError("conflict");
    return this.transition(leaseId, "generating", "writing", {
      estimatedCostMilliunits: record.estimatedCostMilliunits,
      image: image.data,
      output: {
        key,
        version: stored.version,
        bytes: image.data.bytes,
        format: image.data.format,
      },
      writeReceipt: null,
      result: null,
    });
  }

  /** Read exact retained bytes under the current save lease. */
  public async readGenerated(leaseId: string): Promise<Uint8Array> {
    const record = this.requireRecord();
    if (
      record.state !== "writing" ||
      record.leaseId !== leaseId ||
      record.output === null
    )
      throw new MediaOperationError("lease_lost");
    const object = await this.env.APP_ARTIFACTS.get(record.output.key);
    if (
      object?.version !== record.output.version ||
      object.size !== record.output.bytes
    )
      throw new MediaOperationError("partial_init");
    return new Uint8Array(await object.arrayBuffer());
  }

  /** A fixed-path exact-byte save is safe to retry without repeating generation. */
  public releaseWrite(leaseId: string): MediaOperationProjection {
    const record = this.requireRecord();
    if (
      record.state !== "writing" ||
      record.leaseId !== leaseId ||
      record.output === null
    )
      throw new MediaOperationError("lease_lost");
    return this.ctx.storage.transactionSync(() =>
      this.project(
        this.update({
          expectedState: "writing",
          expectedLeaseId: leaseId,
          state: "writing",
          leaseId: null,
          leaseExpiresAt: null,
          estimatedCostMilliunits: record.estimatedCostMilliunits,
          image: record.image,
          output: record.output,
          writeReceipt: null,
          result: null,
        }),
      ),
    );
  }

  // The saved file may contain embedded provenance. Persist its actual size at
  // write acknowledgement; output keeps the original provider bytes for retry.
  /** Record a destination write and move to idempotent settlement. */
  public recordWritten(leaseId: string, receipt: string, written: MediaImage) {
    const image = mediaImageSchema.safeParse(written);
    if (!image.success || !text.safeParse(receipt).success)
      throw new MediaOperationError("invalid_input");
    const record = this.requireRecord();
    if (record.state !== "writing" || record.leaseId !== leaseId)
      throw new MediaOperationError("lease_lost");
    if (image.data.format !== record.image?.format)
      throw new MediaOperationError("conflict");
    return this.transition(leaseId, "writing", "charging", {
      estimatedCostMilliunits: record.estimatedCostMilliunits,
      image: image.data,
      output: record.output,
      writeReceipt: receipt,
      result: null,
    });
  }

  /**
   * Persist a completed Computer write without claiming billing success.
   * A lost receipt may replay the exact retained bytes to the captured path;
   * it never repeats provider generation.
   */
  public recordWrittenWithoutSettlement(
    leaseId: string,
    receipt: string,
    written: MediaImage,
  ) {
    const image = mediaImageSchema.safeParse(written);
    if (!image.success || !text.safeParse(receipt).success)
      throw new MediaOperationError("invalid_input");
    const record = this.requireRecord();
    if (record.state !== "writing" || record.leaseId !== leaseId)
      throw new MediaOperationError("lease_lost");
    if (image.data.format !== record.image?.format)
      throw new MediaOperationError("conflict");
    return this.ctx.storage.transactionSync(() =>
      this.project(
        this.update({
          expectedState: "writing",
          expectedLeaseId: leaseId,
          state: "written",
          leaseId: null,
          leaseExpiresAt: null,
          estimatedCostMilliunits: record.estimatedCostMilliunits,
          image: image.data,
          output: record.output,
          writeReceipt: receipt,
          result: null,
        }),
      ),
    );
  }

  /** Commit the settled receipt after verifying the saved output and admitted price. */
  public recordSucceeded(leaseId: string, resultInput: MediaOperationResult) {
    const result = mediaOperationResultSchema.safeParse(resultInput);
    if (!result.success) throw new MediaOperationError("invalid_input");
    const record = this.requireRecord();
    if (
      record.state !== "charging" ||
      record.leaseId !== leaseId ||
      record.estimatedCostMilliunits === null ||
      record.image === null ||
      record.writeReceipt === null ||
      result.data.generationId !== record.operationId ||
      result.data.bytes !== record.image.bytes ||
      result.data.format !== record.image.format ||
      result.data.costMilliunits !== record.estimatedCostMilliunits
    )
      throw new MediaOperationError("conflict");
    return this.transition(leaseId, "charging", "succeeded", {
      estimatedCostMilliunits: record.estimatedCostMilliunits,
      image: record.image,
      output: record.output,
      writeReceipt: record.writeReceipt,
      result: result.data,
    });
  }

  /** Release preparation or refused admission so the same request can retry. */
  public releaseEstimate(leaseId: string): MediaOperationProjection {
    const record = this.requireRecord();
    if (record.state !== "estimating" || record.leaseId !== leaseId)
      throw new MediaOperationError("lease_lost");
    return this.ctx.storage.transactionSync(() =>
      this.project(
        this.update({
          expectedState: "estimating",
          expectedLeaseId: leaseId,
          state: "admitted",
          leaseId: null,
          leaseExpiresAt: null,
          estimatedCostMilliunits: null,
          image: null,
          output: null,
          writeReceipt: null,
          result: null,
        }),
      ),
    );
  }
}
