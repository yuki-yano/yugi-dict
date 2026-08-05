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
assert.ok(msimeEntries.length >= 150_000, `expected at least 150000 entries, got ${msimeEntries.length}`);
const pairs = new Set<string>();
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
}

for (const [reading, word] of [
  ["＠ぶらっく", "《ブラック・マジシャン》"],
  ["＠りとる", "《Ｓ：Ｐリトルナイト》"],
  ["＠おろかな", "《おろかな埋葬》"],
  ["＠２２４", "《カラクリ小町 弐弐四》"],
  ["＠２４", "《Ｎｏ．２４ 竜血鬼ドラギュラス》"],
  ["＠３", "《アルカナフォースⅢ－ＴＨＥ ＥＭＰＲＥＳＳ》"],
  ["＠３００", "《ＴＧＸ３００》"],
]) {
  assert.equal(pairs.has(`${reading}\u0000${word}`), true, `${reading}: expected candidate ${word}`);
}

const msimeSha256 = createHash("sha256").update(msimeDictionary).digest("hex");
assert.equal(manifest.outputs.msime.sha256, msimeSha256, "MS IME manifest SHA-256");
assert.equal(manifest.stats.dictionaryEntries, msimeEntries.length, "MS IME manifest entry count");
assert.ok(manifest.stats.prefixAliasEntries >= 100_000, "manifest prefix alias count");
assert.ok(manifest.stats.numericAliasEntries >= 500, "manifest numeric alias count");
assert.ok(manifest.stats.ambiguousReadings > 0, "manifest ambiguous reading count");
assert.ok(manifest.stats.maxCandidatesPerReading > 1, "manifest maximum candidate count");
assert.equal(manifest.trigger.prefixMinimumLength, 3);
assert.equal(manifest.trigger.numericMinimumLength, 1);

assert.deepEqual([...atokDictionary.subarray(0, 2)], [0xff, 0xfe], "ATOK BOM");
const atokText = atokDictionary.subarray(2).toString("utf16le");
assert.equal(atokText.replaceAll("\r\n", "").includes("\n"), false, "ATOK CRLF");
const atokLines = atokText.split("\r\n");
assert.equal(atokLines[0], "!!ATOK_TANGO_TEXT_HEADER_1", "ATOK header");
assert.equal(atokLines.at(-1), "", "ATOK trailing CRLF");
const atokEntries = atokLines.slice(1, -1);
assert.ok(atokEntries.length >= 150_000, `expected at least 150000 ATOK entries, got ${atokEntries.length}`);
const atokPairs = new Set<string>();
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
}
for (const [reading, word] of [
  ["＠ぶらっく", "《ブラック・マジシャン》"],
  ["＠りとる", "《Ｓ：Ｐリトルナイト》"],
  ["＠おろかな", "《おろかな埋葬》"],
  ["＠２２４", "《カラクリ小町 弐弐四》"],
  ["＠３００", "《ＴＧＸ３００》"],
]) {
  assert.equal(atokPairs.has(`${reading}\u0000${word}`), true, `ATOK ${reading}: expected candidate ${word}`);
}
const atokSha256 = createHash("sha256").update(atokDictionary).digest("hex");
assert.equal(manifest.outputs.atok.sha256, atokSha256, "ATOK manifest SHA-256");
assert.equal(manifest.stats.atokDictionaryEntries, atokEntries.length, "ATOK manifest entry count");
assert.match(manifest.source.commit, /^[0-9a-f]{40}$/u, "source commit");
assert.equal(manifest.trigger.prefix, "＠");
assert.equal(manifest.trigger.candidateWrapper, "《…》");

process.stdout.write(
  `verified ${msimeEntries.length} MS IME and ${atokEntries.length} ATOK entries from ${manifest.source.commit.slice(0, 12)}\n`,
);
