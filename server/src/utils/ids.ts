import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Unbiased random lowercase alphanumeric string (DNS-label safe). */
export function randomLabel(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 252 = 36 * 7 — reject bytes that would bias the distribution
      if (byte < 252) out += ALPHABET[byte % 36];
      if (out.length === length) break;
    }
  }
  return out;
}

export const newTunnelId = () => `tnl_${randomLabel(10)}`;
export const newRequestId = () => `req_${randomBytes(6).toString('hex')}`;
export const newSessionToken = () => randomBytes(32).toString('base64url');
