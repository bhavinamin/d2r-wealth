import crypto from "node:crypto";
import { read as readCharacter, setConstantData } from "@d2runewizard/d2s";
import { read as readStash } from "@d2runewizard/d2s/lib/d2/stash.js";
import { constants as constants105 } from "@d2runewizard/d2s/lib/data/versions/105_constant_data.js";
import { canonicalBaseName, market, normalizeMarketName } from "./market.js";
import type { ItemLocation, RuneSummary, ValuedItem, ValueSource, WealthReport } from "./types.js";

type D2Item = {
  type_name?: string;
  unique_name?: string;
  set_name?: string;
  runeword_name?: string;
  runeword_id?: number;
  given_runeword?: number;
  type?: string;
  location_id?: number;
  equipped_id?: number;
  alt_position_id?: number;
  ethereal?: number;
  total_nr_of_sockets?: number;
  socketed_items?: D2Item[];
};

type CharacterData = {
  header: { name: string; class: string; level: number; status?: { expansion?: boolean } };
  items: D2Item[];
};

type StashData = {
  type: number;
  pages: Array<{ name: string; items: D2Item[] }>;
};

let constantsReady: Promise<void> | null = null;

const ensureConstantDataLoaded = async () => {
  if (!constantsReady) {
    constantsReady = (async () => {
      const [v96, v105] = await Promise.all([
        import("@d2runewizard/d2s/lib/data/versions/96_constant_data"),
        import("@d2runewizard/d2s/lib/data/versions/105_constant_data"),
      ]);
      setConstantData(96, v96.constants);
      setConstantData(105, v105.constants);
    })();
  }

  await constantsReady;
};

const ITEM_CONTAINER = {
  inventory: 1,
  cube: 4,
  stash: 5,
} as const;

const armorItems = constants105.armor_items as Record<string, { n?: string }>;
const weaponItems = constants105.weapon_items as Record<string, { n?: string }>;
const otherItems = constants105.other_items as Record<string, { n?: string }>;
const runewords = constants105.runewords as Array<{ n?: string } | undefined>;
const runewordRecipes: Record<string, string[]> = {
  Black: ["Thul", "Io", "Nef"],
  Enigma: ["Jah", "Ith", "Ber"],
  Fortitude: ["El", "Sol", "Dol", "Lo"],
  Grief: ["Eth", "Tir", "Lo", "Mal", "Ral"],
  Insight: ["Ral", "Tir", "Tal", "Sol"],
  Spirit: ["Tal", "Thul", "Ort", "Amn"],
};

const liveRuneValueSource = (): ValueSource => ({
  type: "rune-market",
  label: "Live Rune Market",
});

const workbookValueSource = (sheet: string, basis?: string | null): ValueSource => ({
  type: "workbook",
  label: `Workbook: ${sheet}`,
  sheet,
  basis: basis ?? null,
});

const derivedValueSource = (label: string, detail?: string): ValueSource => ({
  type: "derived",
  label,
  detail: detail ?? null,
});

const unresolvedValueSource = (): ValueSource => ({
  type: "unresolved",
  label: "Unresolved Market Value",
});

const isRotwEnvironment = (names: string[]) => {
  const haystack = names.join(" ").toLowerCase();
  return haystack.includes("rotw") || haystack.includes("d2rmm_solo") || haystack.includes("modernsharedstash");
};

const classifyRuleset = (character: CharacterData, names: string[]): "Classic" | "LoD" | "ROTW" => {
  if (isRotwEnvironment(names)) {
    return "ROTW";
  }

  if (character.header.status?.expansion) {
    return "LoD";
  }

  return "Classic";
};

const lookupTypeName = (type?: string) => {
  if (!type) {
    return undefined;
  }

  return armorItems[type]?.n ?? weaponItems[type]?.n ?? otherItems[type]?.n ?? undefined;
};

const lookupRunewordName = (item: D2Item) => {
  if (item.runeword_name) {
    return item.runeword_name;
  }

  if (!item.given_runeword || typeof item.runeword_id !== "number") {
    return undefined;
  }

  return (
    runewords[item.runeword_id]?.n ??
    runewords[item.runeword_id - 459]?.n ??
    runewords[item.runeword_id - 2645]?.n ??
    undefined
  );
};

const tokenCandidates = (item: D2Item) =>
  Array.from(
    new Set(
      [item.unique_name, item.set_name, lookupRunewordName(item), item.type_name, lookupTypeName(item.type), item.type]
        .filter(Boolean)
        .map(String),
    ),
  );

const classifyCharacterItem = (item: D2Item): ItemLocation => {
  if (item.location_id === 1 && item.equipped_id !== 13 && item.equipped_id !== 14) {
    return "equipped";
  }
  if (item.location_id === 0 && item.alt_position_id === ITEM_CONTAINER.stash) {
    return "character-stash";
  }
  if (item.location_id === 0 && item.alt_position_id === ITEM_CONTAINER.cube) {
    return "cube";
  }
  if (item.location_id === 0 && item.alt_position_id === ITEM_CONTAINER.inventory) {
    return "inventory";
  }
  return "other";
};

const displayName = (item: D2Item) =>
  [item.unique_name, item.set_name, lookupRunewordName(item), item.type_name, lookupTypeName(item.type), item.type]
    .find(Boolean)
    ?.toString() ?? "Unknown Item";

const matchExactValue = (item: D2Item) => {
  const candidates = [
    item.unique_name,
    item.set_name,
    lookupRunewordName(item),
    canonicalBaseName(item),
    item.type_name,
    lookupTypeName(item.type),
    item.type,
  ]
    .filter(Boolean)
    .map((name) => normalizeMarketName(String(name)));

  for (const candidate of candidates) {
    const match = market.exactValues[candidate];
    if (match) {
      return match;
    }
  }

  return null;
};

const matchTokenValue = (item: D2Item) => {
  for (const name of tokenCandidates(item)) {
    const match = market.tokenValues[normalizeMarketName(name)];
    if (match) {
      return match;
    }
  }

  return null;
};

const evaluateItem = (item: D2Item, owner: string, location: ItemLocation, source: string): ValuedItem => {
  const resolvedRuneword = lookupRunewordName(item);
  if (resolvedRuneword && runewordRecipes[resolvedRuneword]) {
    const recipe = runewordRecipes[resolvedRuneword];
    const valueHr = runewordRecipes[resolvedRuneword].reduce((total, rune) => total + (market.runeValues[rune] ?? 0), 0);
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: resolvedRuneword,
      owner,
      location,
      source,
      valueHr,
      matchedBy: "exact",
      valueSource: derivedValueSource("Derived Runeword Recipe", `${resolvedRuneword} = ${recipe.join(" + ")}`),
    };
  }

  const tokenMatch = matchTokenValue(item);
  if (tokenMatch) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      owner,
      location,
      source,
      valueHr: tokenMatch.valueHr,
      matchedBy: "token",
      valueSource: tokenMatch.kind === "rune" ? liveRuneValueSource() : workbookValueSource("Workbook Token Market"),
    };
  }

  const exactMatch = matchExactValue(item);
  if (exactMatch) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      owner,
      location,
      source,
      sheet: exactMatch.sheet,
      valueHr: exactMatch.valueHr,
      matchedBy: "exact",
      valueSource: workbookValueSource(exactMatch.sheet, exactMatch.basis),
    };
  }

  const socketedValue = (item.socketed_items ?? []).reduce(
    (total, socketed, index) => total + evaluateItem(socketed, owner, location, `${source} socket ${index + 1}`).valueHr,
    0,
  );
  if (socketedValue > 0) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      owner,
      location,
      source,
      valueHr: socketedValue,
      matchedBy: "socketed",
      valueSource: derivedValueSource("Derived Socketed Value"),
    };
  }

  return {
    id: `${owner}-${source}-${displayName(item)}`,
    name: displayName(item),
    owner,
    location,
    source,
    valueHr: 0,
    matchedBy: "unmatched",
    valueSource: unresolvedValueSource(),
  };
};

const gatherRuneCounts = (items: D2Item[], counts: Map<string, { count: number; looseCount: number }>, looseOnly = false) => {
  for (const item of items) {
    const token = matchTokenValue(item);
    if (token?.kind === "rune") {
      const current = counts.get(token.name) ?? { count: 0, looseCount: 0 };
      current.count += 1;
      current.looseCount += looseOnly ? 1 : 0;
      counts.set(token.name, current);
    }

    gatherRuneCounts(item.socketed_items ?? [], counts, false);
  }
};

export const parseAccountFiles = async (files: FileList | File[]): Promise<WealthReport> => {
  await ensureConstantDataLoaded();
  const importedAt = new Date().toISOString();
  const fileArray = Array.from(files);
  const sourceNames = fileArray.map((file) => file.name);
  const characters: CharacterData[] = [];
  const stashes: Array<{ fileName: string; data: StashData }> = [];

  for (const file of fileArray) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".d2s")) {
      characters.push((await readCharacter(buffer, undefined, { disableItemEnhancements: true })) as unknown as CharacterData);
    } else if (lower.endsWith(".d2i") || lower.endsWith(".sss") || lower.endsWith(".cst")) {
      stashes.push({
        fileName: file.name,
        data: (await readStash(buffer, undefined, null, { disableItemEnhancements: true })) as StashData,
      });
    }
  }

  const valuedItems: ValuedItem[] = [];
  const unmatchedItems: WealthReport["unmatchedItems"] = [];
  const runeCounts = new Map<string, { count: number; looseCount: number }>();
  const characterSummaries: WealthReport["characters"] = [];

  for (const character of characters) {
    const equippedItems = character.items.filter((item) => classifyCharacterItem(item) === "equipped");
    const stashItems = character.items.filter((item) => classifyCharacterItem(item) === "character-stash");
    const carryItems = character.items.filter((item) => ["inventory", "cube"].includes(classifyCharacterItem(item)));

    gatherRuneCounts(character.items, runeCounts, true);

    const characterValues = [
      ...equippedItems.map((item, index) =>
        evaluateItem(item, character.header.name, "equipped", `${character.header.name} equipped ${index + 1}`),
      ),
      ...stashItems.map((item, index) =>
        evaluateItem(item, character.header.name, "character-stash", `${character.header.name} stash ${index + 1}`),
      ),
      ...carryItems.map((item, index) =>
        evaluateItem(item, character.header.name, classifyCharacterItem(item), `${character.header.name} carry ${index + 1}`),
      ),
    ];

    valuedItems.push(...characterValues);
    unmatchedItems.push(
      ...characterValues
        .filter((item) => item.matchedBy === "unmatched")
        .map((item) => ({ owner: item.owner, name: item.name, location: item.location, source: item.source, valueSource: item.valueSource })),
    );

    characterSummaries.push({
      name: character.header.name,
      className: character.header.class,
      level: character.header.level,
      ruleset: classifyRuleset(character, sourceNames),
      equippedHr: Number(characterValues.filter((item) => item.location === "equipped").reduce((a, b) => a + b.valueHr, 0).toFixed(3)),
      stashHr: Number(
        characterValues.filter((item) => item.location !== "equipped").reduce((a, b) => a + b.valueHr, 0).toFixed(3),
      ),
    });
  }

  for (const stash of stashes) {
    for (const [pageIndex, page] of stash.data.pages.entries()) {
      const location: ItemLocation = stash.data.type === 0 ? "shared-stash" : "private-stash";
      gatherRuneCounts(page.items, runeCounts, true);

      const valuations = page.items.map((item, index) =>
        evaluateItem(item, stash.fileName, location, `${stash.fileName} page ${pageIndex + 1} item ${index + 1}`),
      );

      valuedItems.push(...valuations);
      unmatchedItems.push(
        ...valuations
          .filter((item) => item.matchedBy === "unmatched")
          .map((item) => ({ owner: item.owner, name: item.name, location: item.location, source: item.source, valueSource: item.valueSource })),
      );
    }
  }

  const runeSummary: RuneSummary[] = Array.from(runeCounts.entries())
    .map(([name, counts]) => ({
      name,
      count: counts.count,
      looseCount: counts.looseCount,
      totalHr: Number(((market.runeValues[name] ?? 0) * counts.count).toFixed(4)),
      valueSource: liveRuneValueSource(),
    }))
    .sort((left, right) => right.totalHr - left.totalHr || right.count - left.count);

  const totalHr = Number(valuedItems.reduce((total, item) => total + item.valueHr, 0).toFixed(4));
  const runeHr = Number(
    valuedItems
      .filter((item) => item.matchedBy === "token" && market.tokenValues[normalizeMarketName(item.name)]?.kind === "rune")
      .reduce((total, item) => total + item.valueHr, 0)
      .toFixed(4),
  );
  const equippedHr = Number(valuedItems.filter((item) => item.location === "equipped").reduce((a, b) => a + b.valueHr, 0).toFixed(4));
  const stashHr = Number(
    valuedItems
      .filter((item) => item.location === "character-stash" || item.location === "inventory" || item.location === "cube")
      .reduce((a, b) => a + b.valueHr, 0)
      .toFixed(4),
  );
  const sharedHr = Number(
    valuedItems
      .filter((item) => item.location === "shared-stash" || item.location === "private-stash")
      .reduce((a, b) => a + b.valueHr, 0)
      .toFixed(4),
  );
  const saveSetId = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        characters: characters
          .map((character) => ({
            name: String(character.header.name ?? "").toLowerCase(),
            className: String(character.header.class ?? "").toLowerCase(),
          }))
          .sort((left, right) => `${left.name}:${left.className}`.localeCompare(`${right.name}:${right.className}`)),
        stashes: stashes.map((stash) => stash.fileName.toLowerCase()).sort(),
      }),
    )
    .digest("hex");

  return {
    importedAt,
    saveSetId,
    totalHr,
    runeHr,
    equippedHr,
    stashHr,
    sharedHr,
    characters: characterSummaries,
    runeSummary,
    topCharacterStash: valuedItems
      .filter((item) => item.location === "character-stash")
      .filter((item) => item.valueHr > 0)
      .sort((left, right) => right.valueHr - left.valueHr)
      .slice(0, 12),
    topInventory: valuedItems
      .filter((item) => item.location === "inventory" || item.location === "cube")
      .filter((item) => item.valueHr > 0)
      .sort((left, right) => right.valueHr - left.valueHr)
      .slice(0, 12),
    topSharedStash: valuedItems
      .filter((item) => item.location === "shared-stash" || item.location === "private-stash")
      .filter((item) => item.valueHr > 0)
      .sort((left, right) => right.valueHr - left.valueHr)
      .slice(0, 12),
    allValuedItems: valuedItems.sort((left, right) => right.valueHr - left.valueHr),
    unmatchedItems,
    snapshot: {
      importedAt,
      totalHr,
      runeHr,
      equippedHr,
      stashHr,
      sharedHr,
      characterCount: characters.length,
    },
  };
};
