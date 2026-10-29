/**
 * Binary frame format (one WebSocket binary message per chunk):
 *
 *   [kind: u8][idLength: u8][id: ascii][payload ...]
 *
 * BODY carries request bodies (server → CLI) and response bodies (CLI → server);
 * the direction disambiguates which one it is.
 */

export const FrameKind = {
  BODY: 1,
  WS_TEXT: 2,
  WS_BINARY: 3,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  kind: FrameKind;
  id: string;
  payload: Buffer;
}

export function encodeFrame(kind: FrameKind, id: string, payload: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'ascii');
  if (idBytes.length > 255) throw new Error('Frame id too long');
  const header = Buffer.from([kind, idBytes.length]);
  return Buffer.concat([header, idBytes, payload]);
}

export function decodeFrame(data: Buffer): Frame | null {
  if (data.length < 2) return null;
  const kind = data[0] as FrameKind;
  if (kind !== FrameKind.BODY && kind !== FrameKind.WS_TEXT && kind !== FrameKind.WS_BINARY) return null;
  const idLength = data[1]!;
  if (data.length < 2 + idLength) return null;
  return {
    kind,
    id: data.subarray(2, 2 + idLength).toString('ascii'),
    payload: data.subarray(2 + idLength),
  };
}

/** Normalise the various payload shapes `ws` hands us into a single Buffer. */
export function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
