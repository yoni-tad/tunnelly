import net from 'node:net';

/** Resolves true if something accepts TCP connections on host:port. */
export function isLocalPortReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    // autoSelectFamily: "localhost" may resolve to ::1 while the app listens on 127.0.0.1 (or vice versa)
    const socket = net.connect({ host, port, autoSelectFamily: true });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
