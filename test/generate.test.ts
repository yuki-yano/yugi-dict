import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDictionary,
  constants,
  parseJapaneseName,
  run,
  serializeMsIme,
} from "../src/generate.ts";

test("rubyから正式名称と読みを組み立てる", () => {
  assert.deepEqual(
    parseJapaneseName("<ruby>万物創世龍<rt>テンサウザンド・ドラゴン</rt></ruby>"),
    {
      surface: "万物創世龍",
      reading: "てんさうざんどどらごん",
    },
  );
});

test("装飾記号を読みから除き、英数字は全角のまま保持する", () => {
  assert.deepEqual(
    parseJapaneseName(
      "<ruby>Ｎｏ．<rt>ナンバーズ</rt></ruby>３９ <ruby>希望皇<rt>きぼうおう</rt></ruby>ホープ",
    ),
    {
      surface: "Ｎｏ．３９ 希望皇ホープ",
      reading: "なんばーず３９きぼうおうほーぷ",
    },
  );
});

test("ルビのない漢字を拒否する", () => {
  assert.throws(
    () => parseJapaneseName("青眼の白龍"),
    /unannotated kanji/u,
  );
});

test("辞書エントリは＠で始まり、候補を《》で囲み、重複を除く", async () => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "yugi-dict-test-"));
  await fs.writeFile(
    path.join(fixtureDirectory, "1.json"),
    JSON.stringify({ name: { ja: "ブラック・マジシャン" } }),
  );
  await fs.writeFile(
    path.join(fixtureDirectory, "2.json"),
    JSON.stringify({ name: { ja: "ブラック・マジシャン" } }),
  );
  await fs.writeFile(
    path.join(fixtureDirectory, "3.json"),
    JSON.stringify({ name: { en: "Dark Magician" } }),
  );

  const result = await buildDictionary(fixtureDirectory);
  assert.deepEqual(result.entries, [
    {
      reading: "＠ぶらっくまじしゃん",
      word: "《ブラック・マジシャン》",
      pos: "短縮よみ",
    },
  ]);
  assert.deepEqual(result.stats, {
    sourceFiles: 3,
    missingJapaneseName: 1,
    duplicateEntries: 1,
    dictionaryEntries: 1,
  });
});

test("MS IME WORDLISTをUTF-16LE BOM・CRLFで直列化する", () => {
  const output = serializeMsIme([
    {
      reading: "＠ぶらっくまじしゃん",
      word: "《ブラック・マジシャン》",
      pos: "短縮よみ",
    },
  ]);

  assert.deepEqual([...output.subarray(0, 2)], [0xff, 0xfe]);
  const decoded = output.subarray(2).toString("utf16le");
  assert.equal(
    decoded,
    [
      ...constants.HEADER,
      "＠ぶらっくまじしゃん\t《ブラック・マジシャン》\t短縮よみ",
      "",
    ].join("\r\n"),
  );
  assert.equal(decoded.replaceAll("\r\n", "").includes("\n"), false);
});

test("CLIが辞書と再現可能性manifestを出力する", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "yugi-dict-cli-"));
  const inputDirectory = path.join(temporaryDirectory, "cards");
  const outputPath = path.join(temporaryDirectory, "dist", "dictionary.txt");
  const manifestPath = path.join(temporaryDirectory, "dist", "manifest.json");
  await fs.mkdir(inputDirectory);
  await fs.writeFile(
    path.join(inputDirectory, "card.json"),
    JSON.stringify({ name: { ja: "ブラック・マジシャン" } }),
  );

  await run([
    "--input",
    inputDirectory,
    "--output",
    outputPath,
    "--manifest",
    manifestPath,
    "--source-ref",
    "a".repeat(40),
  ]);

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.source.commit, "a".repeat(40));
  assert.equal(manifest.trigger.prefix, "＠");
  assert.equal(manifest.trigger.candidateWrapper, "《…》");
  assert.match(manifest.output.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.stats.dictionaryEntries, 1);
});
