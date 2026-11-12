/** Conservative C2PA detection shared by embed and export. This is not
 * signature validation: any C2PA marker means the file is provider-signed and
 * Prints leaves its bytes untouched. */
export function hasC2paSignature(bytes: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(bytes);
  return text.includes("c2pa") || text.includes("caBX");
}
