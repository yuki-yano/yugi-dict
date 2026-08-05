#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "dist");
const dictionaryPath = path.join(directory, "yugi-dict-msime.txt");
const manifestPath = path.join(directory, "manifest.json");
const dictionary = await fs.readFile(dictionaryPath);
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

assert.deepEqual([...dictionary.subarray(0, 2)], [0xff, 0xfe], "UTF-16LE BOM");
const text = dictionary.subarray(2).toString("utf16le");
assert.equal(text.replaceAll("\r\n", "").includes("\n"), false, "CRLF only");

const lines = text.split("\r\n");
assert.deepEqual(lines.slice(0, 3), [
  "!Microsoft IME Dictionary Tool",
  "!Version:",
  "!Format:WORDLIST",
]);
assert.equal(lines.at(-1), "", "trailing CRLF");

const entries = lines.slice(3, -1);
assert.ok(entries.length >= 14_000, `expected at least 14000 entries, got ${entries.length}`);
const pairs = new Set<string>();
for (const [index, line] of entries.entries()) {
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

const sha256 = createHash("sha256").update(dictionary).digest("hex");
assert.equal(manifest.output.sha256, sha256, "manifest SHA-256");
assert.equal(manifest.stats.dictionaryEntries, entries.length, "manifest entry count");
assert.match(manifest.source.commit, /^[0-9a-f]{40}$/u, "source commit");
assert.equal(manifest.trigger.prefix, "＠");
assert.equal(manifest.trigger.candidateWrapper, "《…》");

process.stdout.write(
  `verified ${entries.length} entries from ${manifest.source.commit.slice(0, 12)}\n`,
);
