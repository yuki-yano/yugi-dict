#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  aliasEntries: number;
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

export function parseJapaneseName(markup: unknown): {
  surface: string;
  reading: string;
  aliasReadings: string[];
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
    }
  }

  return {
    surface,
    reading: normalizedReading,
    aliasReadings: [...aliasReadings].sort(compareText),
  };
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
  let missingJapaneseName = 0;

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
    if (japaneseName == null) {
      missingJapaneseName += 1;
      continue;
    }

    let parsed: ReturnType<typeof parseJapaneseName>;
    try {
      parsed = parseJapaneseName(japaneseName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to convert ${filename}: ${message}`, { cause: error });
    }

    for (const [index, reading] of [parsed.reading, ...parsed.aliasReadings].entries()) {
      const entry = {
        reading: `${PREFIX}${reading}`,
        word: `《${parsed.surface}》`,
        pos: MSIME_POS,
      };
      entries.push(entry);
      if (index === 0) {
        primaryKeys.add(`${entry.reading}\u0000${entry.word}`);
      }
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
  let aliasEntries = 0;
  for (const entry of uniqueEntries) {
    const key = `${entry.reading}\u0000${entry.word}`;
    if (primaryKeys.has(key)) {
      primaryDictionaryEntries += 1;
    } else {
      aliasEntries += 1;
    }
  }

  return {
    entries: uniqueEntries,
    stats: {
      sourceFiles: filenames.length,
      missingJapaneseName,
      duplicateEntries,
      dictionaryEntries: uniqueEntries.length,
      primaryDictionaryEntries,
      aliasEntries,
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
  PREFIX,
  SOURCE_REPOSITORY,
};
