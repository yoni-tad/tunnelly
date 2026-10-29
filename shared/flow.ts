import type { Readable } from 'node:stream';

/** Pause a socket's source stream when this much data is queued in the WebSocket. */
export const WS_HIGH_WATER_MARK = 4 * 1024 * 1024;
const WS_LOW_WATER_MARK = 1024 * 1024;

interface BufferedSocket {
  bufferedAmount: number;
  readyState: number;
}

/**
 * A readable stream that can be paused for several independent reasons
 * (the WebSocket buffer is full, the peer asked us to pause, ...). It only
 * resumes once every reason has been cleared.
 */
export class PausableSource {
  private reasons = new Set<string>();
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(private readonly stream: Readable) {}

  pause(reason: string): void {
    this.reasons.add(reason);
    this.stream.pause();
  }

  resume(reason: string): void {
    this.reasons.delete(reason);
    if (this.reasons.size === 0 && !this.stream.destroyed) this.stream.resume();
  }

  /** Call after sending a chunk: pauses until the socket's send buffer drains. */
  checkSocket(socket: BufferedSocket): void {
    if (socket.bufferedAmount < WS_HIGH_WATER_MARK || this.drainTimer) return;
    this.pause('socket');
    this.drainTimer = setInterval(() => {
      // readyState 1 === OPEN
      if (socket.readyState !== 1 || socket.bufferedAmount < WS_LOW_WATER_MARK) {
        this.dispose();
        this.resume('socket');
      }
    }, 20);
  }

  dispose(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }
}
