import assert from "node:assert/strict";
import test from "node:test";

import {
  alignRomajiWords,
  buildWordBoundaryReadings,
} from "../src/word-boundaries.ts";

test("yaml-yugiのローマ字表記を正式読みの語単位へ対応付ける", () => {
  assert.deepEqual(
    alignRomajiWords("えすぴーりとるないと", "Esu:Pī Ritoru Naito"),
    ["えすぴー", "りとる", "ないと"],
  );
  assert.deepEqual(
    alignRomajiWords("ほーりーないつおるびたえる", "Hōrī Naitsu Orubitaeru"),
    ["ほーりー", "ないつ", "おるびたえる"],
  );
  assert.deepEqual(
    alignRomajiWords("ざいほうのささやき", "Zaihō no Sasayaki"),
    ["ざいほう", "の", "ささやき"],
  );
  assert.deepEqual(
    alignRomajiWords("１３にんめのまいそうしゃ", "Jūsan-ninme no Maisōsha"),
    ["１３", "にんめ", "の", "まいそうしゃ"],
  );
});

test("語の開始位置と終端位置から検索用の読みを作る", () => {
  assert.deepEqual(
    buildWordBoundaryReadings("えすぴーりとるないと", "Esu:Pī Ritoru Naito"),
    {
      units: ["えすぴー", "りとる", "ないと"],
      aliasReadings: ["ないと", "りとるないと"],
      prefixReadings: ["えすぴー", "えすぴーりとる", "りとる"],
    },
  );
});

test("ローマ字と正式読みを安全に対応付けられない場合は境界を作らない", () => {
  assert.equal(
    buildWordBoundaryReadings(
      "ＴＧＸ３ＤＸ２",
      "Tī Jī Ekkusu Surī - Dī Ekkusu Tsū",
    ),
    undefined,
  );
});
