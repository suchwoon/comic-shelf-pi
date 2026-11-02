import assert from "node:assert/strict";
import { it } from "node:test";
import { normalizeSeriesTitle, parseSeriesFilename } from "../lib/series-metadata";

it("recognizes explicit Korean and English volume/chapter markers and decimal specials", () => {
  for (const [filename, seriesTitle, installmentType, installmentNumber] of [
    ["작은 만화 01권.pdf", "작은 만화", "volume", 1],
    ["작은만화02권", "작은만화", "volume", 2],
    ["작은 만화 12.5화", "작은 만화", "chapter", 12.5],
    ["86 1권", "86", "volume", 1],
    ["A Comic Vol. 3.PDF", "A Comic", "volume", 3],
    ["A Comic Volume 0", "A Comic", "volume", 0],
    ["A Comic Chapter 4", "A Comic", "chapter", 4],
    ["결국은 카논 1권 - 요네시로 쿄", "결국은 카논 - 요네시로 쿄", "volume", 1],
    ["젤다의 전설 황혼의 공주 10권 - 히메카와 아키라", "젤다의 전설 황혼의 공주 - 히메카와 아키라", "volume", 10],
    ["A Comic Vol. 3.5 - An Author", "A Comic - An Author", "volume", 3.5],
  ] as const) {
    assert.deepEqual(parseSeriesFilename(filename), { seriesTitle, installmentType, installmentNumber, explicit: true }, filename);
  }
});

it("marks bare numbers as uncertain and leaves standalone titles unclassified", () => {
  assert.deepEqual(parseSeriesFilename("A Comic 01.pdf"), {
    seriesTitle: "A Comic", installmentType: "volume", installmentNumber: 1, explicit: false,
  });
  for (const title of ["Standalone", "게에게 홀려서 - panpanya", "1984", "101권", "___1권 - Author", "A Comic final", "A Comic -1권", "A Comic Vol. Infinity"]) {
    assert.equal(parseSeriesFilename(title), null, title);
  }
});

it("normalizes spacing, width and case without discarding meaningful punctuation", () => {
  assert.equal(normalizeSeriesTitle("  Ａ Comic   - Author "), "a comic - author");
  assert.notEqual(normalizeSeriesTitle("A Comic - Author One"), normalizeSeriesTitle("A Comic - Author Two"));
});
