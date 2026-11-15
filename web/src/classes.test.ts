import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @openasy/ui ships prebuilt CSS: only the utility classes in its styles.css work, and this product's own layouts are
// in app.css with the chat- prefix. Every class the pages use must be in one of the two.
const css =
  readFileSync(new URL("../../node_modules/@openasy/ui/dist/styles.css", import.meta.url), "utf8") +
  readFileSync(new URL("./app.css", import.meta.url), "utf8");
const have = new Set([...css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1")));
const WORDS = new Set([
  "flex",
  "grid",
  "contents",
  "truncate",
  "grow",
  "hidden",
  "relative",
  "absolute",
  "uppercase",
  "rounded",
  "border",
  "underline",
  "italic",
  "sr-only",
]);

/** The class strings of a file: className="..." and the string literals inside cn(...). */
function classStrings(source: string): string[] {
  const out = [...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);
  for (let i = source.indexOf("cn("); i !== -1; i = source.indexOf("cn(", i + 3)) {
    let depth = 0;
    let end = i + 2;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    out.push(...[...source.slice(i, end).matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
  }
  return out;
}

describe("class names", () => {
  it("are all in @openasy/ui's styles or app.css", () => {
    const missing: string[] = [];
    for (const name of readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".tsx"))) {
      for (const s of classStrings(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")))
        for (const c of s.split(/\s+/).filter(Boolean)) if ((c.includes("-") || c.includes(":") || WORDS.has(c)) && !have.has(c)) missing.push(`${name}: ${c}`);
    }
    expect(missing).toEqual([]);
  });
});
