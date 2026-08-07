export class TtlCache<T> {
  private value: T | undefined;
  private filledAt = 0;
  private inFlight: Promise<T> | undefined;
  private generation = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<T> {
    if (this.ttlMs > 0 && this.value !== undefined && this.now() - this.filledAt < this.ttlMs) {
      return this.value;
    }
    if (this.inFlight) return this.inFlight;

    const generation = this.generation;
    const pending: Promise<T> = this.load()
      .then((loaded) => {
        // A concurrent invalidate() bumps the generation; this load's result is stale and must not be stored.
        if (generation === this.generation) {
          this.value = loaded;
          this.filledAt = this.now();
        }
        return loaded;
      })
      .finally(() => {
        // Only if this load is still the current one. invalidate() drops a
        // superseded load, so by the time this runs a newer load may own the slot,
        // and clearing it unconditionally would orphan that one too.
        if (this.inFlight === pending) this.inFlight = undefined;
      });

    this.inFlight = pending;
    return pending;
  }

  invalidate(): void {
    this.value = undefined;
    this.filledAt = 0;
    // Dropped, not just unstored. get() hands back inFlight before it checks
    // anything, so a load already running would otherwise be served to a caller
    // that asked after the invalidation and needs to see the write that caused it.
    // The generation bump keeps that abandoned load from storing its result.
    this.inFlight = undefined;
    this.generation += 1;
  }
}
