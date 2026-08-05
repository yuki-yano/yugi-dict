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
const POS = "短縮よみ";
const PREFIX = "＠";
const SOURCE_REPOSITORY = "https://github.com/DawnbrandBots/yaml-yugi";

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
};

type CliOptions = Record<string, string>;

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
} {
  if (typeof markup !== "string" || markup.length === 0) {
    throw new Error("name.ja must be a non-empty string");
  }

  const rubyPattern = /<ruby>([^<>]+)<rt>([^<>]+)<\/rt><\/ruby>/g;
  let surface = "";
  let reading = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = rubyPattern.exec(markup)) !== null) {
    const literal = markup.slice(cursor, match.index);
    if (literal.includes("<") || literal.includes(">")) {
      throw new Error(`unsupported markup in name.ja: ${markup}`);
    }
    surface += literal + match[1];
    reading += literal + match[2];
    cursor = rubyPattern.lastIndex;
  }

  const tail = markup.slice(cursor);
  if (tail.includes("<") || tail.includes(">")) {
    throw new Error(`unsupported markup in name.ja: ${markup}`);
  }
  surface += tail;
  reading += tail;

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

  return {
    surface,
    reading: normalizedReading,
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

    entries.push({
      reading: `${PREFIX}${parsed.reading}`,
      word: `《${parsed.surface}》`,
      pos: POS,
    });
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

  return {
    entries: uniqueEntries,
    stats: {
      sourceFiles: filenames.length,
      missingJapaneseName,
      duplicateEntries,
      dictionaryEntries: uniqueEntries.length,
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

  for (const required of ["input", "output", "manifest", "source-ref"]) {
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
  const dictionary = serializeMsIme(entries);
  const outputPath = path.resolve(options.output);
  const manifestPath = path.resolve(options.manifest);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(outputPath, dictionary);

  const manifest = {
    format: "Microsoft IME Dictionary Tool WORDLIST",
    source: {
      repository: SOURCE_REPOSITORY,
      commit: options["source-ref"],
    },
    output: {
      filename: path.basename(outputPath),
      encoding: "UTF-16LE with BOM",
      lineEnding: "CRLF",
      sha256: createHash("sha256").update(dictionary).digest("hex"),
    },
    trigger: {
      prefix: PREFIX,
      candidateWrapper: "《…》",
    },
    stats,
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
  POS,
  PREFIX,
  SOURCE_REPOSITORY,
};
