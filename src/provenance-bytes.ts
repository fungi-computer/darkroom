/** Byte composition only; maintained format owners parse and encode containers. */
export function joinBytes(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function startsWithBytes(bytes: Uint8Array, text: string): boolean {
  const prefix = new TextEncoder().encode(text);
  return (
    bytes.length >= prefix.length &&
    prefix.every((value, index) => bytes[index] === value)
  );
}
