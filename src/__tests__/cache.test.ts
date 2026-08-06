import { describe, expect, test } from "bun:test";
import { TtlCache } from "@/cache";

describe("TtlCache", () => {
  test("fetches on a cold read", async () => {
    let calls = 0;
    const clock = { value: 1_000 };
    const cache = new TtlCache(async () => {
      calls += 1;
      return ["a"];
    }, 10_000, () => clock.value);

    expect(await cache.get()).toEqual(["a"]);
    expect(calls).toBe(1);
  });

  test("serves from memory inside the ttl", async () => {
    let calls = 0;
    const clock = { value: 1_000 };
    const cache = new TtlCache(async () => {
      calls += 1;
      return [calls];
    }, 10_000, () => clock.value);

    await cache.get();
    clock.value = 9_000;
    expect(await cache.get()).toEqual([1]);
    expect(calls).toBe(1);
  });

  test("refetches after the ttl expires", async () => {
    let calls = 0;
    const clock = { value: 1_000 };
    const cache = new TtlCache(async () => {
      calls += 1;
      return [calls];
    }, 10_000, () => clock.value);

    await cache.get();
    clock.value = 12_000;
    expect(await cache.get()).toEqual([2]);
    expect(calls).toBe(2);
  });

  test("a ttl of zero disables caching", async () => {
    let calls = 0;
    const cache = new TtlCache(async () => {
      calls += 1;
      return [calls];
    }, 0, () => 1_000);

    await cache.get();
    await cache.get();
    expect(calls).toBe(2);
  });

  test("invalidate forces the next read to refetch", async () => {
    let calls = 0;
    const cache = new TtlCache(async () => {
      calls += 1;
      return [calls];
    }, 10_000, () => 1_000);

    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(calls).toBe(2);
  });

  test("concurrent cold reads share one fetch", async () => {
    let calls = 0;
    const cache = new TtlCache(async () => {
      calls += 1;
      await Promise.resolve();
      return [calls];
    }, 10_000, () => 1_000);

    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  test("a failed fetch does not poison the cache", async () => {
    let calls = 0;
    const cache = new TtlCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return ["ok"];
    }, 10_000, () => 1_000);

    await expect(cache.get()).rejects.toThrow("boom");
    expect(await cache.get()).toEqual(["ok"]);
  });

  test("a rejected load leaves no in-flight promise behind", async () => {
    let calls = 0;
    const cache = new TtlCache(async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    }, 10_000, () => 1_000);

    await expect(cache.get()).rejects.toThrow("boom 1");
    await expect(cache.get()).rejects.toThrow("boom 2");
    expect(calls).toBe(2);
  });

  test("concurrent reads during a rejecting load both reject, and a later read retries", async () => {
    let calls = 0;
    const cache = new TtlCache(async () => {
      calls += 1;
      await Promise.resolve();
      if (calls === 1) throw new Error("boom");
      return ["ok"];
    }, 10_000, () => 1_000);

    const [a, b] = await Promise.allSettled([cache.get(), cache.get()]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(calls).toBe(1);

    expect(await cache.get()).toEqual(["ok"]);
    expect(calls).toBe(2);
  });

  test("invalidate during an in-flight load does not let that load's result be served as fresh afterward", async () => {
    let calls = 0;
    let resolveFirst!: (value: string[]) => void;
    const firstLoad = new Promise<string[]>((resolve) => {
      resolveFirst = resolve;
    });
    const cache = new TtlCache(async () => {
      calls += 1;
      if (calls === 1) return firstLoad;
      return ["second"];
    }, 10_000, () => 1_000);

    const firstGet = cache.get();
    cache.invalidate();
    resolveFirst(["first"]);
    expect(await firstGet).toEqual(["first"]);

    expect(await cache.get()).toEqual(["second"]);
    expect(calls).toBe(2);
  });

  test("a loader returning undefined is treated as a cold cache on every read", async () => {
    let calls = 0;
    const cache = new TtlCache<string | undefined>(async () => {
      calls += 1;
      return undefined;
    }, 10_000, () => 1_000);

    expect(await cache.get()).toBeUndefined();
    expect(await cache.get()).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("ttl boundary: a read at exactly filledAt + ttlMs refetches, one millisecond earlier does not", async () => {
    let calls = 0;
    const clock = { value: 1_000 };
    const cache = new TtlCache(async () => {
      calls += 1;
      return [calls];
    }, 10_000, () => clock.value);

    await cache.get();

    clock.value = 10_999;
    expect(await cache.get()).toEqual([1]);
    expect(calls).toBe(1);

    clock.value = 11_000;
    expect(await cache.get()).toEqual([2]);
    expect(calls).toBe(2);
  });
});
