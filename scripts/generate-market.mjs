import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const repoRoot = process.cwd();
const workbookPath = path.join(repoRoot, "data", "market.xlsx");
const outDir = path.join(repoRoot, "src", "generated");
const outFile = path.join(outDir, "market-data.json");

const workbook = XLSX.readFile(workbookPath);
const curatedRuneHrValues = {
  Pul: 0.03125,
  Um: 0.0625,
  Mal: 0.09375,
  Ist: 0.125,
  Gul: 0.25,
  Vex: 0.5,
  Ohm: 0.625,
  Lo: 0.75,
  Sur: 0.5,
  Ber: 1,
  Jah: 1.25,
  Cham: 0.5,
  Zod: 0.75,
};
const realRunes = new Set([
  "El",
  "Eld",
  "Tir",
  "Nef",
  "Eth",
  "Ith",
  "Tal",
  "Ral",
  "Ort",
  "Thul",
  "Amn",
  "Sol",
  "Shael",
  "Dol",
  "Hel",
  "Io",
  "Lum",
  "Ko",
  "Fal",
  "Lem",
  "Pul",
  "Um",
  "Mal",
  "Ist",
  "Gul",
  "Vex",
  "Ohm",
  "Lo",
  "Sur",
  "Ber",
  "Jah",
  "Cham",
  "Zod",
]);

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*=\s*/g, "=");

const parseTokens = (value) => {
  const text = String(value ?? "")
    .replace(/→/g, "->")
    .replace(/\bRune\b/gi, "")
    .trim();

  if (!text) {
    return [];
  }

  return text
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match =
        chunk.match(/^(\d+)\s+(.+)$/i) ??
        chunk.match(/^(.+?)\s*x\s*(\d+)$/i) ??
        chunk.match(/^(.+?)x\s*(\d+)$/i);

      if (!match) {
        return { name: chunk.trim(), quantity: 1 };
      }

      if (/^\d+$/.test(match[1])) {
        return { name: match[2].trim(), quantity: Number(match[1]) };
      }

      return { name: match[1].trim(), quantity: Number(match[2]) };
    });
};

const tokenAliases = new Map([
  ["diamond", "Perfect Diamond"],
  ["emerald", "Perfect Emerald"],
  ["sapphire", "Perfect Sapphire"],
  ["topaz", "Perfect Topaz"],
  ["ruby", "Perfect Ruby"],
  ["skull", "Perfect Skull"],
  ["jewel", "Jewel"],
  ["jewels", "Jewel"],
  ["p amethysts", "Perfect Amethyst"],
  ["perfect amethyst", "Perfect Amethyst"],
]);

const canonicalToken = (name) => tokenAliases.get(normalize(name)) ?? name.trim();

const runeSheet = XLSX.utils.sheet_to_json(workbook.Sheets["Rune Trades"], { header: 1, raw: false });
const runeUnits = { Fal: 1 };

for (const row of runeSheet) {
  const rune = row?.[1];
  const outputs = row?.[3];
  if (!rune || !outputs || runeUnits[rune] || !realRunes.has(rune)) {
    continue;
  }

  const recipe = parseTokens(outputs);
  if (!recipe.length || recipe.some((part) => !runeUnits[part.name])) {
    continue;
  }

  runeUnits[rune] = recipe.reduce((total, part) => total + runeUnits[part.name] * part.quantity, 0);
}

const berUnits = runeUnits.Ber;
const runeValues = Object.fromEntries(
  Object.entries(runeUnits).map(([name, units]) => [name, Number((units / berUnits).toFixed(6))]),
);
Object.assign(runeValues, curatedRuneHrValues);

for (const rune of ["El", "Eld", "Tir", "Nef", "Eth", "Ith", "Tal", "Ral", "Ort", "Thul", "Amn", "Sol", "Shael", "Dol", "Hel", "Io", "Lum", "Ko"]) {
  runeValues[rune] = Number((runeValues.Pul / 10).toFixed(6));
}

const tokenValues = {};

for (const [rune, valueHr] of Object.entries(runeValues)) {
  tokenValues[normalize(rune)] = { name: rune, valueHr, kind: "rune" };
}

const gemSheet = XLSX.utils.sheet_to_json(workbook.Sheets["Gem Market"], { header: 1, raw: false });
for (const row of gemSheet) {
  const text = String(row?.[0] ?? "").trim();
  const match = text.match(/^10\s+(.+?)\s*->\s*(.+)$/i);
  if (!match) {
    continue;
  }

  const itemName = canonicalToken(match[1]);
  const payout = canonicalToken(match[2]);
  const payoutValue = runeValues[payout];
  if (!payoutValue) {
    continue;
  }

  tokenValues[normalize(itemName)] = {
    name: itemName,
    valueHr: Number((payoutValue / 10).toFixed(6)),
    kind: "token",
  };
}

const recipeTokenValue = (text) =>
  parseTokens(text).reduce((total, token) => {
    const tokenValue = tokenValues[normalize(canonicalToken(token.name))]?.valueHr;
    return total + (tokenValue ?? 0) * token.quantity;
  }, 0);

const entrySheets = [
  "UniqueSet Market",
  "Junk Market",
  "Endgame Market",
  "Base Market",
  "Magic Market",
  "Classic Sunder",
  "Raw Market",
];

const entries = [];
for (const sheetName of entrySheets) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false });
  let section = "";

  for (const row of rows.slice(1)) {
    const first = String(row?.[0] ?? "").trim();
    const second = String(row?.[1] ?? "").trim();
    const third = String(row?.[2] ?? "").trim();
    const fourth = String(row?.[3] ?? "").trim();

    if (!first && !second) {
      continue;
    }

    if (sheetName === "Magic Market" && first && !second && !third) {
      section = first;
      continue;
    }

    if (!first) {
      continue;
    }

    const name = sheetName === "Magic Market" && section && second ? `${section}: ${first}` : first;
    let valueHr = 0;
    let basis = "buy";

    if (sheetName === "Classic Sunder") {
      valueHr = recipeTokenValue(fourth || second);
      basis = fourth ? "sell" : "buy";
    } else if (sheetName === "Base Market" || sheetName === "Raw Market" || sheetName === "Magic Market") {
      valueHr = recipeTokenValue(second);
    } else {
      valueHr = recipeTokenValue(third || second);
      basis = third ? "sell" : "buy";
    }

    if (!valueHr) {
      continue;
    }

    entries.push({
      name,
      normalizedName: normalize(name),
      valueHr: Number(valueHr.toFixed(6)),
      sheet: sheetName,
      basis,
    });
  }
}

const exactValues = Object.fromEntries(
  entries.map((entry) => [
    entry.normalizedName,
    { name: entry.name, valueHr: entry.valueHr, sheet: entry.sheet, basis: entry.basis },
  ]),
);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  outFile,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), runeValues, tokenValues, exactValues, entries }, null, 2)}\n`,
);
console.log(`Generated ${path.relative(repoRoot, outFile)}`);
