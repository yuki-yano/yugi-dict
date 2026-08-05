import { toRomaji } from "wanakana";

const READING_MINIMUM_LENGTH = 3;
const INVALID_UNIT_START = /^[ぁぃぅぇぉっゃゅょゎゕゖー]/u;

const DIGRAPH_ROMAJI = new Map<string, string>([
  ["うぃ", "wi"],
  ["うぇ", "we"],
  ["うぉ", "wo"],
  ["いぇ", "ye"],
  ["ゔぁ", "va"],
  ["ゔぃ", "vi"],
  ["ゔぇ", "ve"],
  ["ゔぉ", "vo"],
  ["ふぁ", "fa"],
  ["ふぃ", "fi"],
  ["ふぇ", "fe"],
  ["ふぉ", "fo"],
  ["ふゅ", "fyu"],
  ["くぁ", "kwa"],
  ["くぃ", "kwi"],
  ["くぇ", "kwe"],
  ["くぉ", "kwo"],
  ["ぐぁ", "gwa"],
  ["ぐぃ", "gwi"],
  ["ぐぇ", "gwe"],
  ["ぐぉ", "gwo"],
  ["すぃ", "swi"],
  ["ずぃ", "zi"],
  ["てぃ", "ti"],
  ["てゅ", "tyu"],
  ["でぃ", "di"],
  ["でゅ", "dyu"],
  ["とぅ", "tu"],
  ["どぅ", "du"],
  ["しぇ", "she"],
  ["じぇ", "je"],
  ["ちぇ", "che"],
  ["つぁ", "tsa"],
  ["つぃ", "tsi"],
  ["つぇ", "tse"],
  ["つぉ", "tso"],
]);

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function romanizeReading(value: string): string {
  const characters = [...value];
  const replacements: Array<readonly [string, string]> = [];
  let markedReading = "";

  for (let index = 0; index < characters.length; index += 1) {
    const digraph = `${characters[index]}${characters[index + 1] ?? ""}`;
    const replacement = DIGRAPH_ROMAJI.get(digraph);
    if (replacement == null) {
      markedReading += characters[index];
      continue;
    }

    const marker = String.fromCodePoint(0xe000 + replacements.length);
    markedReading += marker;
    replacements.push([marker, replacement]);
    index += 1;
  }

  let romanized = toRomaji(markedReading);
  for (const [marker, replacement] of replacements) {
    romanized = romanized.replaceAll(marker, replacement);
  }
  return romanized;
}

function normalizeComparableRomaji(value: string): string {
  // yaml-yugiの長音符号（macron）とWanaKanaの母音・ハイフン表記を
  // 境界照合用にだけ同一視する。辞書へ出す読みには正式読みをそのまま使う。
  let normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replaceAll("-", "");

  let previous = "";
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized
      .replace(/aa/g, "a")
      .replace(/ii/g, "i")
      .replace(/uu/g, "u")
      .replace(/ee/g, "e")
      .replace(/ou/g, "o")
      .replace(/oo/g, "o");
  }
  return normalized;
}

function comparableReadingVariants(unit: string): Set<string> {
  const variants = new Set([normalizeComparableRomaji(romanizeReading(unit))]);
  if (unit === "へ") {
    variants.add("e");
  } else if (unit === "を") {
    variants.add("o");
  } else if (unit === "は") {
    variants.add("wa");
  }
  return variants;
}

export function alignRomajiWords(reading: string, romaji: string): string[] | undefined {
  const characters = [...reading];
  const words = romaji.trim().split(/[\s=-]+/u)
    .map((source) => ({
      source,
      comparable: normalizeComparableRomaji(source),
    }))
    .filter(({ comparable }) => comparable.length > 0);
  if (characters.length === 0 || words.length === 0) {
    return undefined;
  }

  const memo = new Map<string, string[] | undefined>();
  const align = (wordIndex: number, readingStart: number): string[] | undefined => {
    const memoKey = `${wordIndex}:${readingStart}`;
    if (memo.has(memoKey)) {
      return memo.get(memoKey);
    }
    if (wordIndex === words.length) {
      const result = readingStart === characters.length ? [] : undefined;
      memo.set(memoKey, result);
      return result;
    }

    for (let readingEnd = characters.length; readingEnd > readingStart; readingEnd -= 1) {
      const unit = characters.slice(readingStart, readingEnd).join("");
      if (INVALID_UNIT_START.test(unit)) {
        continue;
      }
      // yaml-yugiの正式読みが数字表記でも、ja_romajiは発音を綴るため、
      // 数字の連続は1語として対応付ける。
      const isNumericUnit = /^[0-9０-９Ⅰ-Ⅻ]+$/u.test(unit);
      if (
        !isNumericUnit &&
        !comparableReadingVariants(unit).has(words[wordIndex].comparable)
      ) {
        continue;
      }
      const remainder = align(wordIndex + 1, readingEnd);
      if (remainder != null) {
        const result = [unit, ...remainder];
        memo.set(memoKey, result);
        return result;
      }
    }

    memo.set(memoKey, undefined);
    return undefined;
  };

  return align(0, 0);
}

export function buildWordBoundaryReadings(
  reading: string,
  romaji: string,
): {
  units: string[];
  aliasReadings: string[];
  prefixReadings: string[];
} | undefined {
  const units = alignRomajiWords(reading, romaji);
  if (units == null) {
    return undefined;
  }

  const startIndexes = [0];
  const aliasReadings = new Set<string>();
  for (let index = 1; index < units.length; index += 1) {
    if ([...units[index]].length < 2) {
      continue;
    }
    startIndexes.push(index);
    aliasReadings.add(units.slice(index).join(""));
  }

  const prefixReadings = new Set<string>();
  for (const startIndex of startIndexes) {
    for (let endIndex = startIndex + 1; endIndex < units.length; endIndex += 1) {
      const prefix = units.slice(startIndex, endIndex).join("");
      if (
        [...prefix].length >= READING_MINIMUM_LENGTH &&
        !prefix.endsWith("っ")
      ) {
        prefixReadings.add(prefix);
      }
    }
  }

  return {
    units,
    aliasReadings: [...aliasReadings].sort(compareText),
    prefixReadings: [...prefixReadings].sort(compareText),
  };
}
