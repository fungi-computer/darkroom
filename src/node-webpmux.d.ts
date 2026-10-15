/** Buffer-only public API of pinned node-webpmux 3.2.1; no file or codec APIs. */
declare module "node-webpmux" {
  import type { Buffer } from "node:buffer";
  const webp: {
    Image: new () => {
      xmp: Buffer | undefined;
      load(data: Buffer): Promise<void>;
      save(path: null): Promise<Buffer>;
    };
  };
  export default webp;
}
