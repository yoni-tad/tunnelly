/** True if version `a` is newer than `b` (plain x.y.z versions). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Asks npm for the latest published version. Never throws and never takes
 * longer than `timeoutMs`; returns null when offline or anything goes wrong.
 */
export async function fetchLatestVersion(timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/tunnelly/latest', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
