import type { RequestLogEntry } from '../types/index.js';

/**
 * Request log storage. V1 keeps a bounded ring buffer in memory; a PostgreSQL
 * implementation can be dropped in later behind the same interface.
 */
export interface RequestLogStore {
  add(entry: RequestLogEntry): void;
  /** Newest first. */
  list(limit?: number): RequestLogEntry[];
  get(id: string): RequestLogEntry | undefined;
  count(): number;
}

export class MemoryRequestLogStore implements RequestLogStore {
  private entries: RequestLogEntry[] = [];

  constructor(private readonly limit = 1000) {}

  add(entry: RequestLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  list(limit = 200): RequestLogEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  get(id: string): RequestLogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  count(): number {
    return this.entries.length;
  }
}
