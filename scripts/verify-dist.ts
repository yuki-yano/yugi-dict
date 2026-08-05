#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "dist");
const msimeDictionaryPath = path.join(directory, "yugi-dict-msime.txt");
const atokDictionaryPath = path.join(directory, "yugi-dict-atok.txt");
const manifestPath = path.join(directory, "manifest.json");
const msimeDictionary = await fs.readFile(msimeDictionaryPath);
const atokDictionary = await fs.readFile(atokDictionaryPath);
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

assert.deepEqual([...msimeDictionary.subarray(0, 2)], [0xff, 0xfe], "MS IME BOM");
const msimeText = msimeDictionary.subarray(2).toString("utf16le");
assert.equal(msimeText.replaceAll("\r\n", "").includes("\n"), false, "MS IME CRLF");

const msimeLines = msimeText.split("\r\n");
assert.deepEqual(msimeLines.slice(0, 3), [
  "!Microsoft IME Dictionary Tool",
  "!Version:",
  "!Format:WORDLIST",
]);
assert.equal(msimeLines.at(-1), "", "MS IME trailing CRLF");

const msimeEntries = msimeLines.slice(3, -1);
assert.ok(msimeEntries.length >= 70_000, `expected at least 70000 entries, got ${msimeEntries.length}`);
const pairs = new Set<string>();
const readings = new Set<string>();
const candidatesByReading = new Map<string, Set<string>>();
for (const [index, line] of msimeEntries.entries()) {
  const columns = line.split("\t");
  assert.equal(columns.length, 3, `line ${index + 4}: column count`);
  const [reading, word, pos] = columns;
  assert.match(reading, /^＠[^＠]+$/u, `line ${index + 4}: reading prefix`);
  assert.match(word, /^《[^《》]+》$/u, `line ${index + 4}: candidate wrapper`);
  assert.equal(pos, "短縮よみ", `line ${index + 4}: part of speech`);
  const pair = `${reading}\u0000${word}`;
  assert.equal(pairs.has(pair), false, `line ${index + 4}: duplicate entry`);
  pairs.add(pair);
  readings.add(reading);
  const candidates = candidatesByReading.get(reading) ?? new Set<string>();
  candidates.add(word);
  candidatesByReading.set(reading, candidates);
}

for (const [reading, word] of [
  ["＠ぶらっく", "《ブラック・マジシャン》"],
  ["＠おろかな", "《おろかな埋葬》"],
  ["＠ざいほう", "《罪宝の囁き》"],
  ["＠りとる", "《Ｓ：Ｐリトルナイト》"],
  ["＠ういっち", "《ウィッチクラフト・バイスマスター》"],
  ["＠ういっち", "《魔女の聖夜行》"],
  ["＠ういっち", "《ドドドウィッチ》"],
  ["＠ういっち", "《メメント・エンウィッチ》"],
  ["＠ういっち", "《黒薔薇の魔女》"],
  ["＠ういっち", "《ＷＷ－ウィンター・ベル》"],
  ["＠２２４", "《カラクリ小町 弐弐四》"],
  ["＠２４", "《Ｎｏ．２４ 竜血鬼ドラギュラス》"],
  ["＠３", "《アルカナフォースⅢ－ＴＨＥ ＥＭＰＲＥＳＳ》"],
  ["＠３００", "《ＴＧＸ３００》"],
]) {
  assert.equal(pairs.has(`${reading}\u0000${word}`), true, `${reading}: expected candidate ${word}`);
}
assert.equal(pairs.has("＠ぶらっ\u0000《ブラック・マジシャン》"), false, "partial word reading");
assert.equal(readings.has("＠ざいほ"), false, "partial ruby reading");
assert.equal(pairs.has("＠ひがんのあっ\u0000《彼岸の悪鬼 ラビキャント》"), false, "incomplete sokuon prefix");
const smallWitchCandidates = candidatesByReading.get("＠うぃっち") ?? new Set<string>();
const largeWitchCandidates = candidatesByReading.get("＠ういっち") ?? new Set<string>();
assert.ok(smallWitchCandidates.size >= 50, "expected all witch candidates");
assert.deepEqual([...largeWitchCandidates].sort(), [...smallWitchCandidates].sort(), "witch input variants");
assert.equal(smallWitchCandidates.has("《スウィッチヒーロー》"), false, "switch is not witch");

const msimeSha256 = createHash("sha256").update(msimeDictionary).digest("hex");
assert.equal(manifest.outputs.msime.sha256, msimeSha256, "MS IME manifest SHA-256");
assert.equal(manifest.stats.dictionaryEntries, msimeEntries.length, "MS IME manifest entry count");
assert.ok(manifest.stats.prefixAliasEntries >= 1_000, "manifest prefix alias count");
assert.ok(manifest.stats.wordAliasEntries >= 5_000, "manifest word alias count");
assert.ok(manifest.stats.wordPrefixAliasEntries >= 8_000, "manifest word prefix alias count");
assert.ok(manifest.stats.managedAliasEntries >= 80, "manifest managed alias count");
assert.ok(manifest.stats.numericAliasEntries >= 500, "manifest numeric alias count");
const japaneseNameCount = manifest.stats.sourceFiles - manifest.stats.missingJapaneseName;
assert.equal(
  manifest.stats.wordBoundaryAlignedCards + manifest.stats.wordBoundaryAlignmentFailures,
  japaneseNameCount,
  "manifest word boundary card count",
);
assert.ok(
  manifest.stats.wordBoundaryAlignedCards / japaneseNameCount >= 0.98,
  "manifest word boundary alignment coverage",
);
assert.ok(manifest.stats.ambiguousReadings > 0, "manifest ambiguous reading count");
assert.ok(manifest.stats.maxCandidatesPerReading > 1, "manifest maximum candidate count");
assert.equal(manifest.trigger.prefixStrategy, "structured-and-romaji-word-boundaries");
assert.equal(manifest.trigger.boundaryReadingMinimumLength, 3);
assert.deepEqual(manifest.trigger.boundaryReadingEndingsExcluded, ["っ"]);
assert.equal(manifest.trigger.wordBoundarySource, "name.ja_romaji");
assert.equal(manifest.trigger.wordBoundaryAlignment, "wanakana-romaji");
assert.equal(manifest.trigger.managedAliasRules, 1);
assert.equal(manifest.trigger.numericMinimumLength, 1);

assert.deepEqual([...atokDictionary.subarray(0, 2)], [0xff, 0xfe], "ATOK BOM");
const atokText = atokDictionary.subarray(2).toString("utf16le");
assert.equal(atokText.replaceAll("\r\n", "").includes("\n"), false, "ATOK CRLF");
const atokLines = atokText.split("\r\n");
assert.equal(atokLines[0], "!!ATOK_TANGO_TEXT_HEADER_1", "ATOK header");
assert.equal(atokLines.at(-1), "", "ATOK trailing CRLF");
const atokEntries = atokLines.slice(1, -1);
assert.ok(atokEntries.length >= 70_000, `expected at least 70000 ATOK entries, got ${atokEntries.length}`);
const atokPairs = new Set<string>();
const atokReadings = new Set<string>();
const atokCandidatesByReading = new Map<string, Set<string>>();
for (const [index, line] of atokEntries.entries()) {
  const columns = line.split("\t");
  assert.equal(columns.length, 3, `ATOK line ${index + 2}: column count`);
  const [reading, word, pos] = columns;
  assert.match(reading, /^＠[^＠]+$/u, `ATOK line ${index + 2}: reading prefix`);
  assert.ok([...reading].length <= 32, `ATOK line ${index + 2}: reading length`);
  assert.match(word, /^《[^《》]+》$/u, `ATOK line ${index + 2}: candidate wrapper`);
  assert.ok([...word].length <= 100, `ATOK line ${index + 2}: word length`);
  assert.equal(pos, "名詞", `ATOK line ${index + 2}: part of speech`);
  const pair = `${reading}\u0000${word}`;
  assert.equal(atokPairs.has(pair), false, `ATOK line ${index + 2}: duplicate entry`);
  atokPairs.add(pair);
  atokReadings.add(reading);
  const candidates = atokCandidatesByReading.get(reading) ?? new Set<string>();
  candidates.add(word);
  atokCandidatesByReading.set(reading, candidates);
}
for (const [reading, word] of [
  ["＠ぶらっく", "《ブラック・マジシャン》"],
  ["＠おろかな", "《おろかな埋葬》"],
  ["＠ざいほう", "《罪宝の囁き》"],
  ["＠りとる", "《Ｓ：Ｐリトルナイト》"],
  ["＠ういっち", "《ウィッチクラフト・バイスマスター》"],
  ["＠ういっち", "《魔女の聖夜行》"],
  ["＠ういっち", "《ドドドウィッチ》"],
  ["＠ういっち", "《メメント・エンウィッチ》"],
  ["＠ういっち", "《黒薔薇の魔女》"],
  ["＠ういっち", "《ＷＷ－ウィンター・ベル》"],
  ["＠２２４", "《カラクリ小町 弐弐四》"],
  ["＠３００", "《ＴＧＸ３００》"],
]) {
  assert.equal(atokPairs.has(`${reading}\u0000${word}`), true, `ATOK ${reading}: expected candidate ${word}`);
}
assert.equal(atokPairs.has("＠ぶらっ\u0000《ブラック・マジシャン》"), false, "ATOK partial word reading");
assert.equal(atokReadings.has("＠ざいほ"), false, "ATOK partial ruby reading");
assert.equal(atokPairs.has("＠ひがんのあっ\u0000《彼岸の悪鬼 ラビキャント》"), false, "ATOK incomplete sokuon prefix");
const atokSmallWitchCandidates = atokCandidatesByReading.get("＠うぃっち") ?? new Set<string>();
const atokLargeWitchCandidates = atokCandidatesByReading.get("＠ういっち") ?? new Set<string>();
assert.ok(atokSmallWitchCandidates.size >= 50, "ATOK expected all witch candidates");
assert.deepEqual(
  [...atokLargeWitchCandidates].sort(),
  [...atokSmallWitchCandidates].sort(),
  "ATOK witch input variants",
);
assert.equal(atokSmallWitchCandidates.has("《スウィッチヒーロー》"), false, "ATOK switch is not witch");
const atokSha256 = createHash("sha256").update(atokDictionary).digest("hex");
assert.equal(manifest.outputs.atok.sha256, atokSha256, "ATOK manifest SHA-256");
assert.equal(manifest.stats.atokDictionaryEntries, atokEntries.length, "ATOK manifest entry count");
assert.match(manifest.source.commit, /^[0-9a-f]{40}$/u, "source commit");
assert.equal(manifest.trigger.prefix, "＠");
assert.equal(manifest.trigger.candidateWrapper, "《…》");

process.stdout.write(
  `verified ${msimeEntries.length} MS IME and ${atokEntries.length} ATOK entries from ${manifest.source.commit.slice(0, 12)}\n`,
);
