#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildWordBoundaryReadings } from "./word-boundaries.ts";

const HEADER = [
  "!Microsoft IME Dictionary Tool",
  "!Version:",
  "!Format:WORDLIST",
];
const MSIME_POS = "短縮よみ";
const ATOK_POS = "名詞";
const PREFIX = "＠";
const SOURCE_REPOSITORY = "https://github.com/DawnbrandBots/yaml-yugi";
const ATOK_HEADER = "!!ATOK_TANGO_TEXT_HEADER_1";
const ATOK_READING_LIMIT = 32;
const BOUNDARY_READING_MINIMUM_LENGTH = 3;
const MANAGED_ALIAS_RULES = [
  {
    containedTerm: "うぃっち",
    // 「スウィッチ」は witch ではなく switch の読みなので候補から除く。
    excludedPreviousCharacter: "す",
    aliases: ["うぃっち", "ういっち"],
  },
] as const;

const DECIMAL_DIGITS = new Map<string, string>([
  ...[..."０１２３４５６７８９"].map((digit) => [digit, digit] as const),
  ...[..."0123456789"].map((digit, index) => [digit, [..."０１２３４５６７８９"][index]] as const),
]);
const KANJI_DIGITS = new Map<string, string>([
  ["〇", "０"],
  ["零", "０"],
  ["一", "１"],
  ["壱", "１"],
  ["二", "２"],
  ["弐", "２"],
  ["三", "３"],
  ["参", "３"],
  ["四", "４"],
  ["五", "５"],
  ["六", "６"],
  ["七", "７"],
  ["八", "８"],
  ["九", "９"],
]);
const ROMAN_NUMERALS = new Map<string, number>([
  ["Ⅰ", 1],
  ["Ⅱ", 2],
  ["Ⅲ", 3],
  ["Ⅳ", 4],
  ["Ⅴ", 5],
  ["Ⅵ", 6],
  ["Ⅶ", 7],
  ["Ⅷ", 8],
  ["Ⅸ", 9],
  ["Ⅹ", 10],
  ["Ⅺ", 11],
  ["Ⅻ", 12],
]);

export type DictionaryEntry = {
  reading: string;
  word: string;
  pos: string;
};

export type DictionaryStats = {
  sourceFiles: number;
  missingJapaneseName: number;
  duplicateEntries: number;
  dictionaryEntries: number;
  primaryDictionaryEntries: number;
  structuralAliasEntries: number;
  prefixAliasEntries: number;
  wordAliasEntries: number;
  wordPrefixAliasEntries: number;
  managedAliasEntries: number;
  numericAliasEntries: number;
  wordBoundaryAlignedCards: number;
  wordBoundaryAlignmentFailures: number;
  distinctReadings: number;
  ambiguousReadings: number;
  maxCandidatesPerReading: number;
  topCandidateReadings: Array<{
    reading: string;
    candidates: number;
  }>;
};

type CliOptions = Record<string, string>;

type ReadingUnit = {
  kind: "literal" | "ruby";
  text: string;
  separatorBefore: boolean;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function katakanaToHiragana(value: string): string {
  return value.replace(/[ァ-ヶヽヾ]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0x60),
  );
}

function asciiToFullwidth(value: string): string {
  return value.replace(/[!-~]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0xfee0),
  );
}

function normalizeReading(value: string): string {
  return asciiToFullwidth(katakanaToHiragana(value))
    .replace(/[\p{P}\p{S}\s]/gu, "")
    .normalize("NFC");
}

function normalizeDecimalDigits(value: string): string {
  return [...value].map((character) => DECIMAL_DIGITS.get(character) ?? character).join("");
}

function romanNumeralToReading(value: string): string | undefined {
  const values = [...value].map((character) => ROMAN_NUMERALS.get(character));
  if (values.length === 0 || values.some((number) => number == null)) {
    return undefined;
  }
  const numericValues = values.filter((number): number is number => number != null);
  return normalizeDecimalDigits(String(numericValues.reduce((sum, number) => sum + number, 0)));
}

export function extractNumericReadings(markup: string): string[] {
  const numericGroups: string[] = [];
  let kanjiDigitRun = "";
  let kanjiDigitCount = 0;

  const flushKanjiDigitRun = (): void => {
    // A single numeral kanji may be part of an ordinary word, such as 見参.
    if (kanjiDigitCount >= 2) {
      numericGroups.push(kanjiDigitRun);
    }
    kanjiDigitRun = "";
    kanjiDigitCount = 0;
  };

  const appendLiteralNumericGroups = (literal: string): void => {
    flushKanjiDigitRun();
    const numericPattern = /[0-9０-９]+|[Ⅰ-Ⅻ]+/gu;
    for (const match of literal.matchAll(numericPattern)) {
      const value = match[0];
      const romanReading = romanNumeralToReading(value);
      numericGroups.push(romanReading ?? normalizeDecimalDigits(value));
    }
  };

  const appendRubyNumericGroup = (surface: string): void => {
    const characters = [...surface];
    const decimalDigits = characters.map((character) => DECIMAL_DIGITS.get(character));
    if (decimalDigits.length > 0 && decimalDigits.every((digit) => digit != null)) {
      flushKanjiDigitRun();
      numericGroups.push(decimalDigits.join(""));
      return;
    }

    const kanjiDigits = characters.map((character) => KANJI_DIGITS.get(character));
    if (kanjiDigits.length > 0 && kanjiDigits.every((digit) => digit != null)) {
      kanjiDigitRun += kanjiDigits.join("");
      kanjiDigitCount += characters.length;
      return;
    }

    flushKanjiDigitRun();
    const romanReading = romanNumeralToReading(surface);
    if (romanReading) {
      numericGroups.push(romanReading);
    }
  };

  const rubyPattern = /<ruby>([^<>]+)<rt>[^<>]+<\/rt><\/ruby>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = rubyPattern.exec(markup)) !== null) {
    const literal = markup.slice(cursor, match.index);
    if (literal.length > 0) {
      appendLiteralNumericGroups(literal);
    }
    appendRubyNumericGroup(match[1]);
    cursor = rubyPattern.lastIndex;
  }
  const tail = markup.slice(cursor);
  if (tail.length > 0) {
    appendLiteralNumericGroups(tail);
  }
  flushKanjiDigitRun();

  const readings = new Set<string>();
  for (const group of numericGroups) {
    const characters = [...group];
    for (let start = 0; start < characters.length; start += 1) {
      for (let end = start + 1; end <= characters.length; end += 1) {
        readings.add(characters.slice(start, end).join(""));
      }
    }
  }
  return [...readings].sort(compareText);
}

export function parseJapaneseName(markup: unknown): {
  surface: string;
  reading: string;
  aliasReadings: string[];
  prefixReadings: string[];
} {
  if (typeof markup !== "string" || markup.length === 0) {
    throw new Error("name.ja must be a non-empty string");
  }

  const rubyPattern = /<ruby>([^<>]+)<rt>([^<>]+)<\/rt><\/ruby>/g;
  let surface = "";
  let reading = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  const readingUnits: ReadingUnit[] = [];
  let pendingSeparator = false;

  const appendLiteralUnits = (literal: string): void => {
    const runPattern = /[^\p{P}\p{S}\s]+/gu;
    let run: RegExpExecArray | null;
    let literalCursor = 0;
    while ((run = runPattern.exec(literal)) !== null) {
      const separator = literal.slice(literalCursor, run.index);
      readingUnits.push({
        kind: "literal",
        text: run[0],
        separatorBefore: pendingSeparator || separator.length > 0,
      });
      pendingSeparator = false;
      literalCursor = runPattern.lastIndex;
    }
    if (literal.slice(literalCursor).length > 0) {
      pendingSeparator = true;
    }
  };

  while ((match = rubyPattern.exec(markup)) !== null) {
    const literal = markup.slice(cursor, match.index);
    if (literal.includes("<") || literal.includes(">")) {
      throw new Error(`unsupported markup in name.ja: ${markup}`);
    }
    surface += literal + match[1];
    reading += literal + match[2];
    appendLiteralUnits(literal);
    readingUnits.push({
      kind: "ruby",
      text: match[2],
      separatorBefore: pendingSeparator,
    });
    pendingSeparator = false;
    cursor = rubyPattern.lastIndex;
  }

  const tail = markup.slice(cursor);
  if (tail.includes("<") || tail.includes(">")) {
    throw new Error(`unsupported markup in name.ja: ${markup}`);
  }
  surface += tail;
  reading += tail;
  appendLiteralUnits(tail);

  if (!surface || /[\t\r\n]/u.test(surface)) {
    throw new Error(`invalid dictionary word in name.ja: ${markup}`);
  }

  const normalizedReading = normalizeReading(reading);
  if (!normalizedReading) {
    throw new Error(`empty reading after normalization: ${markup}`);
  }
  if (/\p{Script=Han}/u.test(normalizedReading)) {
    throw new Error(`unannotated kanji in name.ja: ${markup}`);
  }
  if (!/^[ぁ-ゖゝゞーＡ-Ｚａ-ｚ０-９Ⅰ-Ⅻ]+$/u.test(normalizedReading)) {
    throw new Error(`unsupported character in reading "${normalizedReading}": ${markup}`);
  }

  const normalizedUnits = readingUnits.map((unit) => ({
    ...unit,
    text: normalizeReading(unit.text),
  })).filter((unit) => unit.text.length > 0);
  const aliasReadings = new Set<string>();
  const baseReadingStartIndexes = [0];
  for (let index = 1; index < normalizedUnits.length; index += 1) {
    const unit = normalizedUnits[index];
    const previousUnit = normalizedUnits[index - 1];
    const isBoundary = unit.separatorBefore || unit.kind !== previousUnit.kind;
    if (!isBoundary || [...unit.text].length < 2) {
      continue;
    }
    const alias = normalizedUnits.slice(index).map(({ text }) => text).join("");
    if (alias !== normalizedReading) {
      aliasReadings.add(alias);
      baseReadingStartIndexes.push(index);
    }
  }

  const prefixReadings = new Set<string>();
  for (const startIndex of baseReadingStartIndexes) {
    for (let endIndex = startIndex + 1; endIndex < normalizedUnits.length; endIndex += 1) {
      const prefix = normalizedUnits.slice(startIndex, endIndex)
        .map(({ text }) => text)
        .join("");
      if (
        [...prefix].length >= BOUNDARY_READING_MINIMUM_LENGTH &&
        !prefix.endsWith("っ")
      ) {
        prefixReadings.add(prefix);
      }
    }
  }

  return {
    surface,
    reading: normalizedReading,
    aliasReadings: [...aliasReadings].sort(compareText),
    prefixReadings: [...prefixReadings].sort(compareText),
  };
}

export function buildManagedAliasReadings(baseReadings: readonly string[]): string[] {
  const aliases = new Set<string>();
  for (const rule of MANAGED_ALIAS_RULES) {
    const hasEligibleOccurrence = baseReadings.some((reading) => {
      let index = reading.indexOf(rule.containedTerm);
      while (index >= 0) {
        if (index === 0 || reading[index - 1] !== rule.excludedPreviousCharacter) {
          return true;
        }
        index = reading.indexOf(rule.containedTerm, index + 1);
      }
      return false;
    });
    if (hasEligibleOccurrence) {
      for (const alias of rule.aliases) {
        aliases.add(alias);
      }
    }
  }
  return [...aliases].sort(compareText);
}

export async function buildDictionary(inputDirectory: string): Promise<{
  entries: DictionaryEntry[];
  stats: DictionaryStats;
}> {
  const filenames = (await fs.readdir(inputDirectory))
    .filter((filename) => filename.endsWith(".json"))
    .sort(compareText);

  const entries: DictionaryEntry[] = [];
  const primaryKeys = new Set<string>();
  const structuralAliasKeys = new Set<string>();
  const prefixAliasKeys = new Set<string>();
  const wordAliasKeys = new Set<string>();
  const wordPrefixAliasKeys = new Set<string>();
  const managedAliasKeys = new Set<string>();
  const numericAliasKeys = new Set<string>();
  let missingJapaneseName = 0;
  let wordBoundaryAlignedCards = 0;
  let wordBoundaryAlignmentFailures = 0;

  for (const filename of filenames) {
    const filePath = path.join(inputDirectory, filename);
    let card: unknown;
    try {
      card = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse ${filePath}: ${message}`, { cause: error });
    }

    const japaneseName =
      typeof card === "object" && card !== null &&
      "name" in card && typeof card.name === "object" && card.name !== null &&
      "ja" in card.name
        ? card.name.ja
        : undefined;
    const japaneseRomaji =
      typeof card === "object" && card !== null &&
      "name" in card && typeof card.name === "object" && card.name !== null &&
      "ja_romaji" in card.name && typeof card.name.ja_romaji === "string"
        ? card.name.ja_romaji
        : undefined;
    if (japaneseName == null) {
      missingJapaneseName += 1;
      continue;
    }

    let parsed: ReturnType<typeof parseJapaneseName>;
    let numericReadings: string[];
    try {
      if (typeof japaneseName !== "string") {
        throw new Error("name.ja must be a non-empty string");
      }
      parsed = parseJapaneseName(japaneseName);
      numericReadings = extractNumericReadings(japaneseName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to convert ${filename}: ${message}`, { cause: error });
    }

    const baseReadings = [parsed.reading, ...parsed.aliasReadings];
    const wordBoundaries = japaneseRomaji == null
      ? undefined
      : buildWordBoundaryReadings(parsed.reading, japaneseRomaji);
    if (wordBoundaries == null) {
      wordBoundaryAlignmentFailures += 1;
    } else {
      wordBoundaryAlignedCards += 1;
    }

    for (const [index, reading] of baseReadings.entries()) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      if (index === 0) {
        primaryKeys.add(`${entry.reading}\u0000${entry.word}`);
      } else {
        structuralAliasKeys.add(`${entry.reading}\u0000${entry.word}`);
      }
    }

    for (const reading of parsed.prefixReadings) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      prefixAliasKeys.add(`${entry.reading}\u0000${entry.word}`);
    }

    for (const reading of wordBoundaries?.aliasReadings ?? []) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      wordAliasKeys.add(`${entry.reading}\u0000${entry.word}`);
    }

    for (const reading of wordBoundaries?.prefixReadings ?? []) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      wordPrefixAliasKeys.add(`${entry.reading}\u0000${entry.word}`);
    }

    const searchableReadings = [
      ...baseReadings,
      ...(wordBoundaries?.aliasReadings ?? []),
    ];
    for (const reading of buildManagedAliasReadings(searchableReadings)) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      managedAliasKeys.add(`${entry.reading}\u0000${entry.word}`);
    }

    for (const reading of numericReadings) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      numericAliasKeys.add(`${entry.reading}\u0000${entry.word}`);
    }
  }

  entries.sort((left, right) =>
    compareText(left.reading, right.reading) || compareText(left.word, right.word),
  );

  const uniqueEntries = [];
  let duplicateEntries = 0;
  let previousKey;
  for (const entry of entries) {
    const key = `${entry.reading}\u0000${entry.word}`;
    if (key === previousKey) {
      duplicateEntries += 1;
      continue;
    }
    uniqueEntries.push(entry);
    previousKey = key;
  }

  let primaryDictionaryEntries = 0;
  let structuralAliasEntries = 0;
  let prefixAliasEntries = 0;
  let wordAliasEntries = 0;
  let wordPrefixAliasEntries = 0;
  let managedAliasEntries = 0;
  let numericAliasEntries = 0;
  const candidateCounts = new Map<string, number>();
  for (const entry of uniqueEntries) {
    const key = `${entry.reading}\u0000${entry.word}`;
    if (primaryKeys.has(key)) {
      primaryDictionaryEntries += 1;
    } else if (structuralAliasKeys.has(key)) {
      structuralAliasEntries += 1;
    } else if (prefixAliasKeys.has(key)) {
      prefixAliasEntries += 1;
    } else if (wordAliasKeys.has(key)) {
      wordAliasEntries += 1;
    } else if (wordPrefixAliasKeys.has(key)) {
      wordPrefixAliasEntries += 1;
    } else if (managedAliasKeys.has(key)) {
      managedAliasEntries += 1;
    } else if (numericAliasKeys.has(key)) {
      numericAliasEntries += 1;
    } else {
      throw new Error(`dictionary entry has no origin: ${entry.reading} ${entry.word}`);
    }
    candidateCounts.set(entry.reading, (candidateCounts.get(entry.reading) ?? 0) + 1);
  }

  const candidateReadings = [...candidateCounts].map(([reading, candidates]) => ({
    reading,
    candidates,
  })).sort((left, right) =>
    right.candidates - left.candidates || compareText(left.reading, right.reading)
  );

  return {
    entries: uniqueEntries,
    stats: {
      sourceFiles: filenames.length,
      missingJapaneseName,
      duplicateEntries,
      dictionaryEntries: uniqueEntries.length,
      primaryDictionaryEntries,
      structuralAliasEntries,
      prefixAliasEntries,
      wordAliasEntries,
      wordPrefixAliasEntries,
      managedAliasEntries,
      numericAliasEntries,
      wordBoundaryAlignedCards,
      wordBoundaryAlignmentFailures,
      distinctReadings: candidateCounts.size,
      ambiguousReadings: candidateReadings.filter(({ candidates }) => candidates > 1).length,
      maxCandidatesPerReading: candidateReadings[0]?.candidates ?? 0,
      topCandidateReadings: candidateReadings.slice(0, 10),
    },
  };
}

export function serializeMsIme(entries: DictionaryEntry[]): Buffer {
  const lines = [
    ...HEADER,
    ...entries.map(({ reading, word, pos }) => `${reading}\t${word}\t${pos}`),
  ];
  const utf8Text = `${lines.join("\r\n")}\r\n`;
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(utf8Text, "utf16le"),
  ]);
}

export function buildAtokDictionary(entries: DictionaryEntry[]): {
  entries: DictionaryEntry[];
  truncatedReadings: number;
  duplicateEntries: number;
} {
  let truncatedReadings = 0;
  const converted = entries.map((entry) => {
    const characters = [...entry.reading];
    if (characters.length > ATOK_READING_LIMIT) {
      truncatedReadings += 1;
    }
    return {
      reading: characters.slice(0, ATOK_READING_LIMIT).join(""),
      word: entry.word,
      pos: ATOK_POS,
    };
  });

  converted.sort((left, right) =>
    compareText(left.reading, right.reading) || compareText(left.word, right.word),
  );

  const uniqueEntries: DictionaryEntry[] = [];
  let duplicateEntries = 0;
  let previousKey: string | undefined;
  for (const entry of converted) {
    const key = `${entry.reading}\u0000${entry.word}`;
    if (key === previousKey) {
      duplicateEntries += 1;
      continue;
    }
    uniqueEntries.push(entry);
    previousKey = key;
  }

  return {
    entries: uniqueEntries,
    truncatedReadings,
    duplicateEntries,
  };
}

export function serializeAtok(entries: DictionaryEntry[]): Buffer {
  const lines = [
    ATOK_HEADER,
    ...entries.map(({ reading, word, pos }) => `${reading}\t${word}\t${pos}`),
  ];
  const utf8Text = `${lines.join("\r\n")}\r\n`;
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(utf8Text, "utf16le"),
  ]);
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    options[key.slice(2)] = value;
  }

  for (const required of [
    "input",
    "msime-output",
    "atok-output",
    "manifest",
    "source-ref",
  ]) {
    if (!options[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(options["source-ref"])) {
    throw new Error("--source-ref must be a full 40-character Git commit SHA");
  }
  return options;
}

export async function run(argv: string[]): Promise<void> {
  const options = parseArguments(argv);
  const { entries, stats } = await buildDictionary(path.resolve(options.input));
  const msimeDictionary = serializeMsIme(entries);
  const atok = buildAtokDictionary(entries);
  const atokDictionary = serializeAtok(atok.entries);
  const msimeOutputPath = path.resolve(options["msime-output"]);
  const atokOutputPath = path.resolve(options["atok-output"]);
  const manifestPath = path.resolve(options.manifest);

  await fs.mkdir(path.dirname(msimeOutputPath), { recursive: true });
  await fs.mkdir(path.dirname(atokOutputPath), { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(msimeOutputPath, msimeDictionary);
  await fs.writeFile(atokOutputPath, atokDictionary);

  const manifest = {
    source: {
      repository: SOURCE_REPOSITORY,
      commit: options["source-ref"],
    },
    outputs: {
      msime: {
        filename: path.basename(msimeOutputPath),
        format: "Microsoft IME Dictionary Tool WORDLIST",
        encoding: "UTF-16LE with BOM",
        lineEnding: "CRLF",
        sha256: createHash("sha256").update(msimeDictionary).digest("hex"),
      },
      atok: {
        filename: path.basename(atokOutputPath),
        format: "ATOK_TANGO_TEXT_HEADER_1",
        encoding: "UTF-16LE with BOM",
        lineEnding: "CRLF",
        sha256: createHash("sha256").update(atokDictionary).digest("hex"),
      },
    },
    trigger: {
      prefix: PREFIX,
      prefixStrategy: "structured-and-romaji-word-boundaries",
      boundaryReadingMinimumLength: BOUNDARY_READING_MINIMUM_LENGTH,
      boundaryReadingEndingsExcluded: ["っ"],
      wordBoundarySource: "name.ja_romaji",
      wordBoundaryAlignment: "wanakana-romaji",
      managedAliasRules: MANAGED_ALIAS_RULES.length,
      numericMinimumLength: 1,
      candidateWrapper: "《…》",
    },
    stats: {
      ...stats,
      atokDictionaryEntries: atok.entries.length,
      atokTruncatedReadings: atok.truncatedReadings,
      atokDuplicateEntries: atok.duplicateEntries,
    },
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export const constants = {
  HEADER,
  MSIME_POS,
  ATOK_POS,
  ATOK_HEADER,
  ATOK_READING_LIMIT,
  BOUNDARY_READING_MINIMUM_LENGTH,
  PREFIX,
  SOURCE_REPOSITORY,
};
