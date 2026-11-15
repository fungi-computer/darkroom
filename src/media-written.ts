/** What a destination did when asked to delete a file this operation wrote. */
export type MediaRemoval =
  /** The file matched what the operation wrote and was deleted. */
  | "removed"
  /** Nothing was at the path. */
  | "absent"
  /** The path holds different bytes now; it is not this operation's file and was left alone. */
  | "not-ours"
  /** The destination cannot delete files; the host must remove the matching file itself. */
  | "kept";

/** Lowercase hex SHA-256 of the exact bytes written to a destination. */
export async function mediaWrittenDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Delete the file at a destination path only while it still holds the exact
 * bytes the operation wrote, so a path reused for something else is never lost.
 */
export async function removeMediaIfWritten(
  file: Readonly<{
    /** Read the current bytes at the path, or null when absent. */
    read: () => Promise<Uint8Array | null>;
    /** Delete the file at the path. */
    delete: () => Promise<void>;
  }>,
  sha256: string,
): Promise<MediaRemoval> {
  const current = await file.read();
  if (current === null) return "absent";
  if ((await mediaWrittenDigest(current)) !== sha256) return "not-ours";
  await file.delete();
  return "removed";
}
