import type { InstallmentType } from "./types";

export interface SeriesFilenameCandidate {
  seriesTitle: string;
  installmentType: InstallmentType;
  installmentNumber: number;
  explicit: boolean;
}

export function normalizeSeriesTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A bare trailing number is only a candidate; storage requires corroboration. */
export function parseSeriesFilename(filename: string): SeriesFilenameCandidate | null {
  const original = filename.replace(/\.pdf$/i, "").normalize("NFKC").trim();
  // Keep an author suffix in the series identity, while extracting the number.
  const author = original.match(/^(.*(?:\d\s*(?:권|화)|(?:vol(?:ume)?|ch(?:apter)?)\.?\s*\d+(?:\.\d+)?))\s+-\s+(.+)$/i);
  const title = author ? author[1].trim() : original;
  const korean = title.match(/^(.+?)(?:[\s_]+|(?<=[^\d.\s_-]))(\d+(?:\.\d+)?)\s*(권|화)$/u);
  const english = title.match(/^(.+?)[\s_-]+(vol(?:ume)?|ch(?:apter)?)\.?\s*(\d+(?:\.\d+)?)$/i);
  const bare = !korean && !english ? title.match(/^(.+?)[\s_]+(\d+(?:\.\d+)?)$/u) : null;
  const match = korean || english || bare;
  if (!match) return null;
  const baseTitle = match[1].trim().replace(/[\s_-]+$/u, "");
  const seriesTitle = author ? `${baseTitle} - ${author[2].trim()}` : baseTitle;
  const installmentNumber = Number(english ? english[3] : match[2]);
  if (!baseTitle || seriesTitle.length > 200 || !Number.isFinite(installmentNumber)
    || installmentNumber < 0 || installmentNumber > Number.MAX_SAFE_INTEGER) return null;
  return {
    seriesTitle,
    installmentType: korean?.[3] === "화" || /^ch/i.test(english?.[2] || "") ? "chapter" : "volume",
    installmentNumber,
    explicit: !!(korean || english),
  };
}
