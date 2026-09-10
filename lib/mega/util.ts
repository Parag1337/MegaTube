/** MEGA base64url helpers. */

/** Decode a MEGA base64url string (charset A-Za-z0-9_-) to a Buffer. */
export function b64UrlToBuffer(input: string): Buffer {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/** Encode a Buffer as MEGA base64url (no padding). */
export function bufferToB64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}