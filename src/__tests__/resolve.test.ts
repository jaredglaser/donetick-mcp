import { describe, expect, test } from "bun:test";
import { AmbiguousMatchError, NoMatchError, normalizeName, resolveOne } from "@/resolve";

interface Item {
  id: number;
  name: string;
  hint?: string;
}

const items: Item[] = [
  { id: 1, name: "Water plants", hint: "due in 2 days" },
  { id: 2, name: "Water plants upstairs", hint: "due tomorrow" },
  { id: 3, name: "Take out trash" },
  { id: 4, name: "\u{1F5D1}\u{FE0F} Recycling" },
];

const by = (item: Item) => item.name;

describe("normalizeName", () => {
  test("folds case", () => {
    expect(normalizeName("Water Plants")).toBe(normalizeName("water plants"));
  });

  test("folds NFD to NFC", () => {
    expect(normalizeName("Café")).toBe(normalizeName("Café"));
  });

  test("strips emoji variation selectors", () => {
    expect(normalizeName("\u{1F5D1}\u{FE0F} Recycling")).toBe(normalizeName("\u{1F5D1} Recycling"));
  });

  test("collapses surrounding whitespace", () => {
    expect(normalizeName("  Take out trash  ")).toBe(normalizeName("Take out trash"));
  });
});

describe("resolveOne", () => {
  test("exact match wins", () => {
    expect(resolveOne("Take out trash", items, by).id).toBe(3);
  });

  test("case-insensitive match wins over substring", () => {
    // "water plants" is an exact case-insensitive hit on item 1 and a substring of
    // item 2. The higher tier must win rather than reporting ambiguity.
    expect(resolveOne("water plants", items, by).id).toBe(1);
  });

  test("substring matches in the chore-contains-query direction", () => {
    expect(resolveOne("upstairs", items, by).id).toBe(2);
  });

  test("a query longer than the name does not match", () => {
    expect(() => resolveOne("water plants upstairs and downstairs", items, by)).toThrow(NoMatchError);
  });

  test("emoji mismatch still resolves", () => {
    expect(resolveOne("\u{1F5D1} Recycling", items, by).id).toBe(4);
  });

  test("ambiguity at the substring tier lists candidates with hints", () => {
    try {
      resolveOne("water", items, by, (item) => item.hint ?? "");
      throw new Error("expected an ambiguity error");
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousMatchError);
      const message = (error as Error).message;
      expect(message).toContain("Water plants");
      expect(message).toContain("Water plants upstairs");
      expect(message).toContain("due tomorrow");
    }
  });

  test("duplicate names produce a candidate list that is still distinguishable", () => {
    const dupes: Item[] = [
      { id: 10, name: "Dishes", hint: "due today, Jared" },
      { id: 11, name: "Dishes", hint: "due Friday, unassigned" },
    ];
    try {
      resolveOne("Dishes", dupes, by, (item) => item.hint ?? "");
      throw new Error("expected an ambiguity error");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("due today, Jared");
      expect(message).toContain("due Friday, unassigned");
      expect(message).toContain("10");
      expect(message).toContain("11");
    }
  });

  test("no match suggests the closest names", () => {
    try {
      resolveOne("Watr plnts", items, by);
      throw new Error("expected a no-match error");
    } catch (error) {
      expect(error).toBeInstanceOf(NoMatchError);
      expect((error as Error).message).toContain("Water plants");
    }
  });

  test("an empty candidate list reports nothing found", () => {
    expect(() => resolveOne("anything", [], by)).toThrow(NoMatchError);
  });
});

describe("resolveOne edge cases", () => {
  test("an empty query is rejected instead of matching every item", () => {
    // "" is a substring of every name, so without a guard this would silently
    // resolve to whichever item happens to come first.
    expect(() => resolveOne("", items, by)).toThrow(NoMatchError);
  });

  test("a whitespace-only query is rejected the same way", () => {
    expect(() => resolveOne("   ", items, by)).toThrow(NoMatchError);
  });

  test("an exact case-sensitive match wins over a substring hit in another item", () => {
    const pair: Item[] = [
      { id: 1, name: "trash" },
      { id: 2, name: "take out trash" },
    ];
    expect(resolveOne("trash", pair, by).id).toBe(1);
  });

  test("two items differing only by case are ambiguous under a case-insensitive query", () => {
    const pair: Item[] = [
      { id: 1, name: "Trash" },
      { id: 2, name: "trash" },
    ];
    expect(() => resolveOne("TRASH", pair, by)).toThrow(AmbiguousMatchError);
  });

  test("normalizeName does not apply Turkish dotless-i case folding", () => {
    // toLocaleLowerCase("tr") would fold "TITLE" to "tıtle". Locale must be pinned to "en".
    expect(normalizeName("TITLE")).toBe("title");
  });

  test("an item with an empty-string name does not crash resolution or spuriously match", () => {
    const withBlank: Item[] = [
      { id: 1, name: "" },
      { id: 2, name: "Trash" },
    ];
    expect(resolveOne("Trash", withBlank, by).id).toBe(2);
    expect(() => resolveOne("nothing close", withBlank, by)).toThrow(NoMatchError);
  });

  test("suggestions are capped at 3 even with many candidates", () => {
    const many: Item[] = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      name: `AAAA${i}`,
    }));
    try {
      resolveOne("ZZZZZ", many, by);
      throw new Error("expected a no-match error");
    } catch (error) {
      expect(error).toBeInstanceOf(NoMatchError);
      const message = (error as Error).message;
      const namesPresent = many.filter((item) => message.includes(item.name));
      expect(namesPresent.length).toBeLessThanOrEqual(3);
    }
  });

  test("a throwing hintOf does not crash the ambiguity path", () => {
    const dupes: Item[] = [
      { id: 1, name: "Dishes" },
      { id: 2, name: "Dishes" },
    ];
    const throwingHint = (): string => {
      throw new Error("hint lookup failed");
    };
    expect(() => resolveOne("Dishes", dupes, by, throwingHint)).toThrow(AmbiguousMatchError);
  });

  test("an undefined hintOf result does not add a blank suffix", () => {
    const dupes: Item[] = [
      { id: 1, name: "Dishes" },
      { id: 2, name: "Dishes" },
    ];
    try {
      resolveOne("Dishes", dupes, by, () => undefined as unknown as string);
      throw new Error("expected an ambiguity error");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("(undefined)");
    }
  });

  test("an item type with no id field degrades to a positional label, not 'id undefined'", () => {
    interface NoIdItem {
      name: string;
    }
    const dupes: NoIdItem[] = [{ name: "Dishes" }, { name: "Dishes" }];
    try {
      resolveOne("Dishes", dupes, (item) => item.name);
      throw new Error("expected an ambiguity error");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("id undefined");
      expect(message).toContain("#1");
      expect(message).toContain("#2");
    }
  });
});
