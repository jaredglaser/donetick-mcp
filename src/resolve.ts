export class AmbiguousMatchError extends Error {
  constructor(query: string, candidates: string[]) {
    super(
      `"${query}" matches ${candidates.length} items. Ask which one is meant, then call again with the id.\n${candidates.join("\n")}`,
    );
    this.name = "AmbiguousMatchError";
  }
}

export class NoMatchError extends Error {
  constructor(query: string, suggestions: string[]) {
    super(
      suggestions.length > 0
        ? `Nothing matches "${query}". Closest names: ${suggestions.join(", ")}.`
        : `Nothing matches "${query}", and there is nothing to match against.`,
    );
    this.name = "NoMatchError";
  }
}

const VARIATION_SELECTORS = /[\u{FE00}-\u{FE0F}]/gu;

export function normalizeName(value: string): string {
  return value
    .normalize("NFC")
    .replace(VARIATION_SELECTORS, "")
    .trim()
    .toLocaleLowerCase("en");
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }
  return previous[cols - 1]!;
}

/**
 * Tiers are exact, case-insensitive, then substring in the direction
 * name.includes(query). The first tier with exactly one hit wins; a tier with more
 * than one hit is an error rather than a fall-through, so "water plants" resolves to
 * the exact chore instead of reporting ambiguity against "water plants upstairs".
 */
export function resolveOne<T>(
  query: string,
  items: T[],
  nameOf: (item: T) => string,
  hintOf?: (item: T) => string,
): T {
  // A blank query would make every item pass the substring tier, silently
  // "resolving" to whichever comes first. Reject it before any tier runs.
  if (query.trim().length === 0) {
    throw new NoMatchError(query, []);
  }

  const normalizedQuery = normalizeName(query);

  const tiers: Array<(item: T) => boolean> = [
    (item) => nameOf(item) === query,
    (item) => normalizeName(nameOf(item)) === normalizedQuery,
    (item) => normalizeName(nameOf(item)).includes(normalizedQuery),
  ];

  for (const predicate of tiers) {
    const hits = items.filter(predicate);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new AmbiguousMatchError(
        query,
        hits.map((item, index) => {
          let hint: string | undefined;
          try {
            hint = hintOf?.(item);
          } catch {
            hint = undefined;
          }
          const rawId = (item as { id?: unknown }).id;
          const id = typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined;
          const label = id !== undefined ? `id ${id}` : `#${index + 1}`;
          const suffix = hint && hint.length > 0 ? ` (${hint})` : "";
          return `  ${label}: ${nameOf(item)}${suffix}`;
        }),
      );
    }
  }

  const suggestions = items
    .map((item) => ({ name: nameOf(item), distance: editDistance(normalizedQuery, normalizeName(nameOf(item))) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((entry) => entry.name);

  throw new NoMatchError(query, suggestions);
}

/**
 * Member lookup is case and whitespace insensitive, matching either the display name
 * or the username. The single predicate, so every tool that takes a person's name
 * agrees on what counts as a match: an exact-equality copy in one tool once made
 * "sam" work in reassign_chore and fail in complete_chore.
 */
export function findMember<T extends { displayName: string; username: string }>(
  name: string,
  members: T[],
): T | undefined {
  const wanted = normalizeName(name);
  return members.find(
    (m) => normalizeName(m.displayName) === wanted || normalizeName(m.username) === wanted,
  );
}

export function resolveMember<T extends { displayName: string; username: string }>(
  name: string,
  members: T[],
): T {
  const found = findMember(name, members);
  if (!found) {
    throw new Error(
      `"${name}" is not a member of this circle. Known members: ${
        members.map((m) => m.displayName).join(", ") || "none"
      }.`,
    );
  }
  return found;
}

