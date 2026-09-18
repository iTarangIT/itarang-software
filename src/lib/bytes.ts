/**
 * Node `Buffer` is typed `Uint8Array<ArrayBufferLike>` — its backing store may
 * be a SharedArrayBuffer — so it is not a `BlobPart` under the DOM lib. Copy the
 * bytes into a plain ArrayBuffer for `new Blob([...])` / FormData uploads.
 */
export function bufferToArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}
