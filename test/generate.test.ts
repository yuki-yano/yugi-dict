import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDictionary,
  buildAtokDictionary,
  buildManagedAliasReadings,
  constants,
  extractNumericReadings,
  parseJapaneseName,
  run,
  serializeAtok,
  serializeMsIme,
} from "../src/generate.ts";

test("読み単位の境界だけから前方読みを作る", () => {
  assert.deepEqual(parseJapaneseName("ブラック・マジシャン").prefixReadings, ["ぶらっく"]);
  assert.deepEqual(
    parseJapaneseName(
      "<ruby>罪<rt>ざい</rt></ruby><ruby>宝<rt>ほう</rt></ruby>の" +
        "<ruby>囁<rt>ささや</rt></ruby>き",
    ).prefixReadings,
    ["ささや", "ざいほう", "ざいほうの", "ざいほうのささや"],
  );
  assert.deepEqual(
    parseJapaneseName(
      "<ruby>Ｓ<rt>エス</rt></ruby>：<ruby>Ｐ<rt>ピー</rt></ruby>リトルナイト",
    ).prefixReadings,
    ["えすぴー"],
  );
  assert.equal(
    parseJapaneseName(
      "<ruby>彼<rt>ひ</rt></ruby><ruby>岸<rt>がん</rt></ruby>の" +
        "<ruby>悪<rt>あっ</rt></ruby><ruby>鬼<rt>き</rt></ruby> ラビキャント",
    ).prefixReadings.includes("ひがんのあっ"),
    false,
  );
});

test("管理済み別名は対象の複合語と入力揺れだけに追加する", () => {
  assert.deepEqual(buildManagedAliasReadings(["りとるないと"]), []);
  assert.deepEqual(buildManagedAliasReadings(["うぃっちくらふとばいすますたー"]), [
    "うぃっち",
    "ういっち",
  ]);
  assert.deepEqual(buildManagedAliasReadings(["くりしゅなーどうぃっち"]), [
    "うぃっち",
    "ういっち",
  ]);
  assert.deepEqual(buildManagedAliasReadings(["すうぃっちひーろー"]), []);
});

test("カード名中の数列から1文字以上の部分読みを作る", () => {
  assert.deepEqual(
    extractNumericReadings(
      "カラクリ<ruby>小<rt>こ</rt></ruby><ruby>町<rt>まち</rt></ruby> " +
        "<ruby>弐<rt>ニ</rt></ruby><ruby>弐<rt>ニ</rt></ruby><ruby>四<rt>シ</rt></ruby>",
    ),
    ["２", "２２", "２２４", "２４", "４"],
  );
  assert.deepEqual(
    extractNumericReadings("<ruby>Ｎｏ．<rt>ナンバーズ</rt></ruby>２４ 竜血鬼ドラギュラス"),
    ["２", "２４", "４"],
  );
  assert.deepEqual(
    extractNumericReadings("アルカナフォース<ruby>Ⅲ<rt>スリー</rt></ruby>"),
    ["３"],
  );
});

test("普通の単語中にある単独の数字漢字は数字読みを作らない", () => {
  assert.deepEqual(
    extractNumericReadings("ヒーロー<ruby>見<rt>けん</rt></ruby><ruby>参<rt>ざん</rt></ruby>"),
    [],
  );
});

test("rubyから正式名称と読みを組み立てる", () => {
  assert.deepEqual(
    parseJapaneseName("<ruby>万物創世龍<rt>テンサウザンド・ドラゴン</rt></ruby>"),
    {
      surface: "万物創世龍",
      reading: "てんさうざんどどらごん",
      aliasReadings: [],
      prefixReadings: [],
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
      aliasReadings: ["きぼうおうほーぷ", "ほーぷ", "３９きぼうおうほーぷ"],
      prefixReadings: [
        "きぼうおう",
        "なんばーず",
        "なんばーず３９",
        "なんばーず３９きぼうおう",
        "３９きぼうおう",
      ],
    },
  );
});

test("ルビのない漢字を拒否する", () => {
  assert.throws(
    () => parseJapaneseName("青眼の白龍"),
    /unannotated kanji/u,
  );
});

test("カード名の構造境界から検索用の別名読みを作る", () => {
  assert.deepEqual(
    parseJapaneseName("<ruby>Ｓ<rt>エス</rt></ruby>：<ruby>Ｐ<rt>ピー</rt></ruby>リトルナイト"),
    {
      surface: "Ｓ：Ｐリトルナイト",
      reading: "えすぴーりとるないと",
      aliasReadings: ["ぴーりとるないと", "りとるないと"],
      prefixReadings: ["えすぴー"],
    },
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
  assert.equal(
    result.entries.some(({ reading, word }) =>
      reading === "＠ぶらっ" && word === "《ブラック・マジシャン》"
    ),
    false,
  );
  assert.equal(
    result.entries.some(({ reading, word }) =>
      reading === "＠ぶらっく" && word === "《ブラック・マジシャン》"
    ),
    true,
  );
  assert.equal(
    result.entries.some(({ reading, word }) =>
      reading === "＠まじし" && word === "《ブラック・マジシャン》"
    ),
    false,
  );
  assert.equal(new Set(result.entries.map(({ reading, word }) => `${reading}\u0000${word}`)).size, result.entries.length);
  assert.equal(result.stats.sourceFiles, 3);
  assert.equal(result.stats.missingJapaneseName, 1);
  assert.equal(result.stats.primaryDictionaryEntries, 1);
  assert.equal(result.stats.structuralAliasEntries, 1);
  assert.equal(result.stats.prefixAliasEntries, 1);
  assert.equal(result.stats.managedAliasEntries, 0);
  assert.equal(result.stats.numericAliasEntries, 0);
  assert.equal(result.stats.maxCandidatesPerReading, 1);
});

test("短いかな読みと数字読みで複数候補を残す", async () => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "yugi-dict-alias-test-"));
  const cards = [
    "<ruby>Ｓ<rt>エス</rt></ruby>：<ruby>Ｐ<rt>ピー</rt></ruby>リトルナイト",
    "リトル・フェアリー",
    "おろかな<ruby>埋<rt>まい</rt></ruby><ruby>葬<rt>そう</rt></ruby>",
    "おろかな<ruby>副<rt>ふく</rt></ruby><ruby>葬<rt>そう</rt></ruby>",
    "<ruby>Ｎｏ．<rt>ナンバーズ</rt></ruby>２４ <ruby>竜血鬼<rt>りゅうけつき</rt></ruby>ドラギュラス",
    "カラクリ<ruby>小<rt>こ</rt></ruby><ruby>町<rt>まち</rt></ruby> " +
      "<ruby>弐<rt>ニ</rt></ruby><ruby>弐<rt>ニ</rt></ruby><ruby>四<rt>シ</rt></ruby>",
    "アルカナフォース<ruby>Ⅲ<rt>スリー</rt></ruby>－" +
      "<ruby>ＴＨＥ ＥＭＰＲＥＳＳ<rt>ジ・エンプレス</rt></ruby>",
    "ＴＧＸ３００",
    "ウィッチクラフト・バイスマスター",
    "<ruby>魔女の聖夜行<rt>ウィッチクラフト・ワルプルギース</rt></ruby>",
    "クリシュナード・ウィッチ",
    "<ruby>罪<rt>ざい</rt></ruby><ruby>宝<rt>ほう</rt></ruby>の" +
      "<ruby>囁<rt>ささや</rt></ruby>き",
    "<ruby>黒薔薇の魔女<rt>ブラック・ローズ・ウィッチ</rt></ruby>",
    "<ruby>ＷＷ<rt>ウィンド・ウィッチ</rt></ruby>－ウィンター・ベル",
    "ドドドウィッチ",
    "メメント・エンウィッチ",
    "スウィッチヒーロー",
  ];
  const romajiByIndex = new Map<number, string>([
    [0, "Esu:Pī Ritoru Naito"],
    [8, "Witchikurafuto Baisumasutā"],
    [9, "Witchikurafuto Warupurugīsu"],
    [12, "Burakku Rōzu Witchi"],
    [13, "Windo Witchi - Wintā Beru"],
    [14, "Dododo Witchi"],
    [15, "Memento Enwitchi"],
    [16, "Suwitchi Hīrō"],
  ]);
  await Promise.all(cards.map((japaneseName, index) =>
    fs.writeFile(
      path.join(fixtureDirectory, `${index}.json`),
      JSON.stringify({
        name: {
          ja: japaneseName,
          ...(romajiByIndex.has(index) ? { ja_romaji: romajiByIndex.get(index) } : {}),
        },
      }),
    )
  ));

  const { entries, stats } = await buildDictionary(fixtureDirectory);
  const candidatesAt = (reading: string): string[] =>
    entries.filter((entry) => entry.reading === reading).map((entry) => entry.word).sort();

  assert.deepEqual(candidatesAt("＠りとる"), [
    "《リトル・フェアリー》",
    "《Ｓ：Ｐリトルナイト》",
  ]);
  const expectedWitchCandidates = [
    "《ウィッチクラフト・バイスマスター》",
    "《クリシュナード・ウィッチ》",
    "《ドドドウィッチ》",
    "《メメント・エンウィッチ》",
    "《黒薔薇の魔女》",
    "《魔女の聖夜行》",
    "《ＷＷ－ウィンター・ベル》",
  ];
  for (const reading of ["＠うぃっち", "＠ういっち"]) {
    const candidates = candidatesAt(reading);
    assert.equal(candidates.length, expectedWitchCandidates.length);
    for (const expected of expectedWitchCandidates) {
      assert.equal(candidates.includes(expected), true, `${reading}: ${expected}`);
    }
    assert.equal(candidates.includes("《スウィッチヒーロー》"), false);
  }
  assert.deepEqual(candidatesAt("＠おろかな"), [
    "《おろかな副葬》",
    "《おろかな埋葬》",
  ]);
  assert.deepEqual(candidatesAt("＠２２４"), ["《カラクリ小町 弐弐四》"]);
  assert.deepEqual(candidatesAt("＠２４"), [
    "《カラクリ小町 弐弐四》",
    "《Ｎｏ．２４ 竜血鬼ドラギュラス》",
  ]);
  assert.equal(candidatesAt("＠３").includes("《アルカナフォースⅢ－ＴＨＥ ＥＭＰＲＥＳＳ》"), true);
  assert.equal(candidatesAt("＠３００").includes("《ＴＧＸ３００》"), true);
  assert.deepEqual(candidatesAt("＠ざいほう"), ["《罪宝の囁き》"]);
  assert.deepEqual(candidatesAt("＠ざいほ"), []);
  assert.ok(stats.ambiguousReadings > 0);
  assert.ok(stats.numericAliasEntries > 0);
  assert.ok(stats.managedAliasEntries > 0);
  assert.ok(stats.wordAliasEntries > 0);
  assert.ok(stats.wordPrefixAliasEntries > 0);
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

test("ATOK単語ファイルをUTF-16LE BOM・CRLFで直列化する", () => {
  const sourceEntry = {
    reading: `＠${"あ".repeat(40)}`,
    word: "《長いカード名》",
    pos: "短縮よみ",
  };
  const atok = buildAtokDictionary([sourceEntry]);
  assert.equal(atok.truncatedReadings, 1);
  assert.equal([...atok.entries[0].reading].length, 32);
  assert.equal(atok.entries[0].pos, "名詞");

  const output = serializeAtok(atok.entries);
  assert.deepEqual([...output.subarray(0, 2)], [0xff, 0xfe]);
  const decoded = output.subarray(2).toString("utf16le");
  assert.equal(decoded.startsWith(`${constants.ATOK_HEADER}\r\n＠`), true);
  assert.equal(decoded.endsWith("\t《長いカード名》\t名詞\r\n"), true);
  assert.equal(decoded.replaceAll("\r\n", "").includes("\n"), false);
});

test("CLIが辞書と再現可能性manifestを出力する", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "yugi-dict-cli-"));
  const inputDirectory = path.join(temporaryDirectory, "cards");
  const msimeOutputPath = path.join(temporaryDirectory, "dist", "msime.txt");
  const atokOutputPath = path.join(temporaryDirectory, "dist", "atok.txt");
  const manifestPath = path.join(temporaryDirectory, "dist", "manifest.json");
  await fs.mkdir(inputDirectory);
  await fs.writeFile(
    path.join(inputDirectory, "card.json"),
    JSON.stringify({ name: { ja: "ブラック・マジシャン" } }),
  );

  await run([
    "--input",
    inputDirectory,
    "--msime-output",
    msimeOutputPath,
    "--atok-output",
    atokOutputPath,
    "--manifest",
    manifestPath,
    "--source-ref",
    "a".repeat(40),
  ]);

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.source.commit, "a".repeat(40));
  assert.equal(manifest.trigger.prefix, "＠");
  assert.equal(manifest.trigger.prefixStrategy, "structured-and-romaji-word-boundaries");
  assert.equal(manifest.trigger.boundaryReadingMinimumLength, 3);
  assert.deepEqual(manifest.trigger.boundaryReadingEndingsExcluded, ["っ"]);
  assert.equal(manifest.trigger.wordBoundarySource, "name.ja_romaji");
  assert.equal(manifest.trigger.wordBoundaryAlignment, "wanakana-romaji");
  assert.equal(manifest.trigger.managedAliasRules, 1);
  assert.equal(manifest.trigger.numericMinimumLength, 1);
  assert.equal(manifest.trigger.candidateWrapper, "《…》");
  assert.match(manifest.outputs.msime.sha256, /^[0-9a-f]{64}$/u);
  assert.match(manifest.outputs.atok.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(manifest.stats.dictionaryEntries > 2);
  assert.equal(manifest.stats.structuralAliasEntries, 1);
  assert.ok(manifest.stats.prefixAliasEntries > 0);
  assert.equal(manifest.stats.managedAliasEntries, 0);
  assert.equal(manifest.stats.wordBoundaryAlignedCards, 0);
  assert.equal(manifest.stats.wordBoundaryAlignmentFailures, 1);
  assert.equal(manifest.stats.numericAliasEntries, 0);
  assert.equal(manifest.stats.atokDictionaryEntries, manifest.stats.dictionaryEntries);
});
