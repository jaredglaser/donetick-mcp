import { describe, expect, test } from "bun:test";

/**
 * The rules in CLAUDE.md that are structural rather than stylistic, enforced here
 * because nothing else enforces them. There is no linter in this repo, and two
 * modules exist solely to preserve the first of these: confirm.ts restates an SDK
 * type so the confirmation decision can be tested, and probe.ts holds the startup
 * gate outside the entry point for the same reason. Both of those are wasted the
 * moment something else imports the SDK.
 */
const SRC = new URL("../", import.meta.url).pathname;

async function sourceFiles(): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: SRC })) paths.push(path);
  return paths.sort();
}

async function readAll(): Promise<Array<{ path: string; text: string }>> {
  return Promise.all(
    (await sourceFiles()).map(async (path) => ({ path, text: await Bun.file(SRC + path).text() })),
  );
}

/**
 * Every `${...}` in the text, with braces balanced so a nested object literal ends
 * the expression where it really ends, and scanned across the whole file so a
 * template broken over several lines is still one expression. A line-at-a-time regex
 * missed both.
 */
function interpolationsIn(text: string): Array<{ expr: string; index: number }> {
  const found: Array<{ expr: string; index: number }> = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== "$" || text[i + 1] !== "{") continue;
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) {
        found.push({ expr: text.slice(i, j + 1), index: i });
        i = j;
        break;
      }
    }
  }
  return found;
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;

describe("module boundaries", () => {
  test("only index.ts imports the MCP SDK", async () => {
    const offenders = (await readAll())
      .filter(({ path }) => path !== "index.ts")
      // An import statement, not the bare string: this file names the package in its
      // own source and would otherwise report itself.
      .filter(({ text }) => /\bfrom "@modelcontextprotocol\/server/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("only client.ts calls fetch", async () => {
    // The seam every test in this suite depends on: fetch is injected into the
    // client, so a call anywhere else is a request no test can intercept.
    const offenders = (await readAll())
      .filter(({ path }) => path !== "client.ts" && !path.includes("__tests__"))
      .filter(({ text }) => /\bfetch\(/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("nothing under src writes to stdout", async () => {
    // stdout is the JSON-RPC transport, so one operational line there corrupts the
    // protocol stream. This is the highest-consequence rule in the file and its check
    // used to cover two of the eight ways to reach stdout.
    //
    // Measured under Bun 1.3.14 on 2026-08-08: console.debug, dir, table, group,
    // count and process.stdout.write all go to stdout; only warn and error go to
    // stderr. So the allowlist is the two that are safe, rather than a denylist of
    // the ones thought of at the time.
    const STDOUT_ROUTE = /console\.(?!error\b|warn\b)\w+\s*\(|process\.stdout\b/;
    // The server is what speaks the protocol; a test process has no transport to
    // corrupt, and this file has to name the routes in prose to explain itself.
    const offenders = (await readAll())
      .filter(({ path }) => !path.includes("__tests__"))
      .filter(({ text }) => STDOUT_ROUTE.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("nothing below the registry imports the write module", async () => {
    // tools/write.ts sits above its peers. It used to declare the shared tool context
    // that chore-lookup.ts and the other four tool modules needed, so the lowest
    // helper pointed back up at a module depending on it. Type-only, so it erased,
    // but it became a real ESM cycle the moment anyone wanted a value from write.ts.
    const offenders = (await readAll())
      .filter(({ path }) => path.startsWith("tools/") && !path.includes("__tests__"))
      .filter(({ path }) => path !== "tools/index.ts" && path !== "tools/write.ts")
      .filter(({ text }) => /from "@\/tools\/write"/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  test("a chore or member name never reaches a message unsanitized", async () => {
    // Names are written by any circle member and reach the model as untrusted text.
    // fail() renders a thrown Error as plain text with newlines intact, so one
    // carrying a line break forges a whole extra candidate line with an id no lookup
    // produced.
    //
    // Matched on the property rather than on a spelling. The first version of this
    // check listed the exact identifiers the edit beside it had just fixed, so a
    // renamed local, a template split across lines, or a `.map(x => x.name)` all
    // walked past it, and it sat green while three raw sites remained in read.ts.
    // Any interpolation reaching a name field counts unless safeName is in it.
    // Bracket access counts: chore["name"] reaches the same string and the dotted
    // form was the only one matched.
    const NAME_FIELD = /(?:\.|\[["'])(?:name|displayName|username)\b/;
    // The functions that sanitize on the way through. Keep this list short: every
    // entry is a place the check stops looking, so adding one is a decision to trust
    // that function forever.
    const SANITIZERS = ["safeName", "describeKnown"];

    /**
     * Removes whole sanitizer calls, so that what remains is the unsanitized part.
     *
     * Every name in an expression has to be inside one, not just some name: asking
     * whether the text mentions safeName passes `${a ? safeName(x.name) : y.name}`.
     * Balanced paren matching rather than a regex, because describeKnown(xs.map((x)
     * => x.name)) nests and a [^()]* body stops at the inner paren.
     */
    const stripSanitizerCalls = (expr: string): string => {
      for (const fn of SANITIZERS) {
        for (;;) {
          const at = expr.indexOf(`${fn}(`);
          if (at === -1) break;
          let depth = 0;
          let end = -1;
          for (let i = at + fn.length; i < expr.length; i++) {
            if (expr[i] === "(") depth++;
            else if (expr[i] === ")" && --depth === 0) {
              end = i;
              break;
            }
          }
          if (end === -1) break;
          expr = `${expr.slice(0, at)}OK${expr.slice(end + 1)}`;
        }
      }
      return expr;
    };
    const offenders: string[] = [];
    for (const { path, text } of await readAll()) {
      // config.ts interpolates a hard-coded environment variable label, and resolve.ts
      // is where safeName is defined and applied.
      if (path.includes("__tests__") || path === "config.ts" || path === "resolve.ts") continue;

      // Locals holding an unsanitized name, so that lifting one out of the template
      // does not clear it. This was the surviving evasion: the check saw
      // `${chore.name}` and not `const n = chore.name` two lines above it.
      const tainted = new Set<string>();
      // The right-hand side stops at a newline, a semicolon, or the next declaration
      // keyword. Without that last one a single-line arrow body swallowed the
      // declaration nested inside it, so the inner name never got tainted and the
      // extracted-local evasion still walked through.
      const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:(?!\b(?:const|let|var)\b)[^\n;])+)/g;
      for (const [, ident, rhs] of text.matchAll(DECLARATION)) {
        if (NAME_FIELD.test(stripSanitizerCalls(rhs!))) tainted.add(ident!);
      }
      // `const { name } = chore` binds the field to a bare identifier, so neither the
      // declaration pattern above nor NAME_FIELD sees it at the use site.
      const DESTRUCTURED = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
      for (const [, inner] of text.matchAll(DESTRUCTURED)) {
        for (const part of inner!.split(",")) {
          const [key, alias] = part.split(":").map((piece) => piece.trim());
          if (/^(?:name|displayName|username)$/.test(key ?? "")) tainted.add(alias || key!);
        }
      }
      const carriesTainted = (expr: string): boolean =>
        [...tainted].some((id) => new RegExp(`\\b${id}\\b`).test(expr));

      for (const { expr, index } of interpolationsIn(text)) {
        // Stripped first, then both questions asked of what is left. A tainted local
        // wrapped in safeName disappears with the call, and one that is not still
        // shows.
        const bare = stripSanitizerCalls(expr);
        if (!NAME_FIELD.test(bare) && !carriesTainted(bare)) continue;
        offenders.push(`${path}:${lineAt(text, index)}  ${expr.replace(/\s+/g, " ")}`);
      }

      // Neither of these is a template, so no interpolation scan reaches them.
      const COERCED = /(?:\+\s*|String\(\s*)[A-Za-z_$][\w$.[\]]*\.(?:name|displayName|username)\b/g;
      for (const match of text.matchAll(COERCED)) {
        if (!NAME_FIELD.test(stripSanitizerCalls(match[0]))) continue;
        offenders.push(`${path}:${lineAt(text, match.index)}  ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("no doc comment is orphaned from what it describes", async () => {
    // Review passes keep finding a JSDoc block separated from its function by a newer
    // block inserted above it, on several different functions. Each time the fix was
    // another edit, and each time it happened again, because prose has no compiler.
    // This is the compiler.
    const orphans: string[] = [];
    for (const { path, text } of await readAll()) {
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // A block ends either on its own closing line or, for the one-line form, on
        // the same line it opened. Checking only the former let a seventh instance
        // through: a helper inserted directly under a single-line /** ... */ left
        // that comment describing the wrong function, and this test stayed green.
        const endsDocBlock =
          trimmed === "*/" || (trimmed.startsWith("/**") && trimmed.endsWith("*/"));
        if (!endsDocBlock) return;
        const next = lines.slice(index + 1).find((l) => l.trim().length > 0);
        if (next !== undefined && next.trim().startsWith("/**")) {
          orphans.push(`${path}:${index + 1}`);
        }
      });
    }

    expect(orphans).toEqual([]);
  });

  test("production modules import by alias, not by relative path", async () => {
    // Relative imports are for a test reaching its own subject. Anywhere else they
    // make a module's place in the graph depend on where it happens to sit.
    const offenders = (await readAll())
      .filter(({ path }) => !path.includes("__tests__"))
      .filter(({ text }) => /\bfrom "\.\.?\//.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
