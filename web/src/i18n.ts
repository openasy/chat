// The pages' words, one JSON file per language in messages/, read with i18next through @openasy/ui (its ADR 0006).
// They follow the locale set on BrandProvider; English is the default, and messages from the API are shown as they come.
import { defineMessages } from "@openasy/ui";
import de from "./messages/de.json";
import en from "./messages/en.json";
import tr from "./messages/tr.json";

export const useT = defineMessages("chat", { en, tr, de });
export type T = ReturnType<typeof useT>;

let viewer = "en";
/** The language picked in the top bar, for dates and numbers written outside React (ADR 0006). App sets it while rendering. */
export const viewerLocale = (): string => viewer;
export function setViewerLocale(locale: string): void {
  viewer = locale;
}

/** A retention as the file writes it (2y, 90d, forever), in the viewer's words: "2 years". */
export function retentionLabel(r: string, t: T): string {
  if (r === "forever") return t("retention.forever");
  const m = /^(\d+)([dwmy])$/.exec(r);
  if (!m) return r;
  const n = Number(m[1]);
  return t(`retention.${m[2] as "d" | "w" | "m" | "y"}`, { count: n });
}
