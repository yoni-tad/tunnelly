import net from 'node:net';

/**
 * Finds the address the local app actually accepts connections on, or null if
 * nothing is listening. "localhost" may be ::1 or 127.0.0.1 depending on the app
 * (Vite often binds only ::1); resolving it once avoids paying the lookup and
 * the IPv4/IPv6 fallback delay on every new connection.
 */
export function findLocalAddress(host: string, port: number, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, autoSelectFamily: true });
    const done = (address: string | null) => {
      socket.destroy();
      resolve(address);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(socket.remoteAddress ?? host));
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}

/** Resolves true if something accepts TCP connections on host:port. */
export async function isLocalPortReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return (await findLocalAddress(host, port, timeoutMs)) !== null;
}
