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
    this.inFlight = this.load()
      .then((loaded) => {
        // A concurrent invalidate() bumps the generation; this load's result is stale and must not be stored.
        if (generation === this.generation) {
          this.value = loaded;
          this.filledAt = this.now();
        }
        return loaded;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  invalidate(): void {
    this.value = undefined;
    this.filledAt = 0;
    this.generation += 1;
  }
}
