/** Facts an erased operation keeps: its destination file, and whether a billing hold may be open. */
export type MediaErasureMarker = Readonly<{
  /** The destination path the operation wrote or could have written. */
  destinationPath: string | null;
  /** SHA-256 of the bytes it wrote or was about to write there. */
  writtenSha256: string | null;
  /** The operation was erased before it finished. */
  abandonedGeneration: boolean;
}>;

/** SQL rows stay untrusted until the owner decodes their stored representation. */
export type MediaOperationStorage = {
  /** Native synchronous SQL interface. */
  sql: {
    /** Execute a native SQL statement with positional bindings. */
    exec(
      query: string,
      ...bindings: (string | number | null)[]
    ): {
      /** Read the native SQL rows as objects for boundary decoding. */
      toArray(): readonly object[];
    };
  };
  /** Run one atomic synchronous local mutation. */
  transactionSync<T>(body: () => T): T;
  /** Read the durable erasure marker. */
  isErased(): Promise<boolean>;
  /**
   * Persist the durable erasure marker with the facts the host needs after
   * erasure. Never removed: nothing may delete it.
   */
  markErased(marker: MediaErasureMarker): Promise<void>;
  /** Read the facts kept with the marker, or null for a marker without them. */
  readErasureMarker(): Promise<MediaErasureMarker | null>;
  /** List local key-value storage keys for erasure readback. */
  listKeys(): Promise<readonly string[]>;
  /** Remove any scheduled background alarm. */
  deleteAlarm(): Promise<void>;
  /** Remove the named key-value entries. */
  deleteKeys(keys: readonly string[]): Promise<void>;
  /** Read the current background alarm, or null. */
  getAlarm(): Promise<number | null>;
  /** Schedule background generation at the given timestamp. */
  setAlarm(timestamp: number): Promise<void>;
};

/** The identity, serialization and storage owned by one media operation. */
export type MediaOperationContext = {
  /** Durable operation identity selected by the host. */
  id: {
    /** Stable error name or durable object name. */
    name: string | undefined;
  };
  /** Host-owned SQL, key-value storage and alarms. */
  storage: MediaOperationStorage;
  /** Serialize asynchronous owner initialization with requests. */
  blockConcurrencyWhile<T>(body: () => Promise<T>): Promise<T>;
};

/** Object metadata consumed by retention and recovery; mirrors the native R2 fields used here. */
export type MediaOperationObject = Readonly<{
  /** Immutable output key. */
  key: string;
  /** Object version captured when its exact bytes were written. */
  version: string;
  /** Stored byte length. */
  size: number;
  /** Actual retained MIME type. */
  httpMetadata?: Readonly<{
    /** MIME type of the retained output. */ contentType?: string;
  }>;
}>;

/** Exact object operations needed for immutable media outputs and references. */
export type MediaOperationBucket = {
  /** Conditionally retain immutable provider bytes or background reference bytes. */
  put(
    key: string,
    bytes: Uint8Array,
    options?: Readonly<{
      /** Native R2 conditional write, used once for an immutable output. */
      onlyIf?: Readonly<{
        /** Refuse an existing output key. */ etagDoesNotMatch: string;
      }>;
      /** MIME type for exact-output recovery. */
      httpMetadata?: Readonly<{
        /** MIME type of the retained output. */ contentType: string;
      }>;
      /** Decoded reference format and dimensions for background generation. */
      customMetadata?: Readonly<Record<string, string>>;
    }>,
  ): Promise<Readonly<{
    /** Stored immutable object version. */ version: string;
  }> | null>;
  /** Read immutable object metadata without loading bytes. */
  head(key: string): Promise<MediaOperationObject | null>;
  /** Read retained object bytes and metadata. */
  get(key: string): Promise<
    | (Omit<MediaOperationObject, "httpMetadata"> &
        Readonly<{
          /** Stored background reference metadata. */
          customMetadata?: Readonly<Record<string, string>>;
          /** Read the exact retained object bytes. */
          arrayBuffer: () => Promise<ArrayBuffer>;
        }>)
    | null
  >;
  /** Delete the owner-selected object key. */
  delete(key: string): Promise<void>;
};
