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
  quantity?: number;
  amount_in_shared_stash?: number;
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

const unresolvedValueSource = (detail?: string): ValueSource => ({
  type: "unresolved",
  label: "Unresolved Market Value",
  detail: detail ?? null,
});

const ambiguousValueSource = (detail?: string): ValueSource => ({
  type: "ambiguous",
  label: "Low-Confidence Market Value",
  detail: detail ?? null,
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

const isLowConfidenceStoredAccessory = (item: D2Item, location: ItemLocation) => {
  if (location === "equipped") {
    return false;
  }

  return new Set(["amu", "rin", "jew", "cm1", "cm2", "cm3"]).has(item.type ?? "");
};

const isSuspiciousParsedItem = (item: D2Item) => {
  const type = String(item.type ?? "");
  return !/^[a-z0-9]{3}$/i.test(type);
};

const toWarningEntry = (item: ValuedItem) => ({
  kind: (item.matchedBy === "ambiguous" ? "ambiguous" : "unresolved") as "ambiguous" | "unresolved",
  owner: item.owner,
  name: item.name,
  location: item.location,
  source: item.source,
  valueSource: item.valueSource,
  includedInTotal: false as const,
});

const isMaterialLikeToken = (item: D2Item) => {
  const name = displayName(item);
  const normalized = normalizeMarketName(name);
  const type = String(item.type ?? "");
  return (
    /^r\d{2}$/i.test(type) ||
    /^pk[123]$/i.test(type) ||
    /^ce[hdbf]$/i.test(type) ||
    /^xa\d$/i.test(type) ||
    normalized.includes("rune") ||
    normalized.includes("key of") ||
    normalized.includes("essence") ||
    normalized.includes("worldstone shard") ||
    normalized.includes("jewel") ||
    normalized.includes("topaz") ||
    normalized.includes("emerald") ||
    normalized.includes("sapphire") ||
    normalized.includes("ruby") ||
    normalized.includes("amethyst") ||
    normalized.includes("skull")
  );
};

const stackQuantity = (item: D2Item) => {
  const inventoryQuantity = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1;
  if (typeof item.amount_in_shared_stash !== "number") {
    return inventoryQuantity;
  }

  if (isMaterialLikeToken(item)) {
    return item.amount_in_shared_stash > 0 ? item.amount_in_shared_stash : inventoryQuantity;
  }

  return inventoryQuantity;
};

const collectWarnings = (
  items: ValuedItem[],
  valuationWarnings: WealthReport["valuationWarnings"]["items"],
  unmatchedItems: WealthReport["unmatchedItems"],
) => {
  const warnings = items.filter((item) => item.matchedBy === "unmatched" || item.matchedBy === "ambiguous").map(toWarningEntry);
  valuationWarnings.push(...warnings);
  unmatchedItems.push(...warnings.filter((warning) => warning.kind === "unresolved"));
};

const evaluateItem = (item: D2Item, owner: string, location: ItemLocation, source: string): ValuedItem => {
  const quantity = stackQuantity(item);

  if (isLowConfidenceStoredAccessory(item, location)) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      quantity,
      owner,
      location,
      source,
      valueHr: 0,
      matchedBy: "ambiguous",
      valueSource: ambiguousValueSource("Stored accessory pricing needs affix-aware matching before it can affect HR totals."),
    };
  }

  if (location !== "equipped" && isSuspiciousParsedItem(item)) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      quantity,
      owner,
      location,
      source,
      valueHr: 0,
      matchedBy: "ambiguous",
      valueSource: ambiguousValueSource("Parsed item data looked suspicious, so it was excluded from trust-critical totals."),
    };
  }

  const resolvedRuneword = lookupRunewordName(item);
  if (resolvedRuneword && runewordRecipes[resolvedRuneword]) {
    const recipe = runewordRecipes[resolvedRuneword];
    const valueHr = runewordRecipes[resolvedRuneword].reduce((total, rune) => total + (market.runeValues[rune] ?? 0), 0);
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: resolvedRuneword,
      quantity,
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
      quantity,
      owner,
      location,
      source,
      valueHr: tokenMatch.valueHr * quantity,
      matchedBy: "token",
      valueSource: tokenMatch.kind === "rune" ? liveRuneValueSource() : workbookValueSource("Workbook Token Market"),
    };
  }

  const exactMatch = matchExactValue(item);
  if (exactMatch) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      quantity,
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
      quantity,
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
    quantity,
    owner,
    location,
    source,
    valueHr: 0,
    matchedBy: "unmatched",
    valueSource: unresolvedValueSource("No workbook, token, or derived pricing match was found for this item."),
  };
};

const gatherRuneCounts = (items: D2Item[], counts: Map<string, { count: number; looseCount: number }>, looseOnly = false) => {
  for (const item of items) {
    const token = matchTokenValue(item);
    if (token?.kind === "rune") {
      const quantity = stackQuantity(item);
      if (quantity <= 0) {
        continue;
      }
      const current = counts.get(token.name) ?? { count: 0, looseCount: 0 };
      current.count += quantity;
      current.looseCount += looseOnly ? quantity : 0;
      counts.set(token.name, current);
    }

    gatherRuneCounts(item.socketed_items ?? [], counts, false);
  }
};

const isInventoryLocation = (location: ItemLocation) => location === "inventory" || location === "cube";
const isCharacterStashLocation = (location: ItemLocation) => location === "character-stash";
const isSharedStashLocation = (location: ItemLocation) => location === "shared-stash" || location === "private-stash";
const isRuneValuation = (item: ValuedItem) => item.matchedBy === "token" && market.tokenValues[normalizeMarketName(item.name)]?.kind === "rune";
const sumItemValues = (items: ValuedItem[]) => items.reduce((total, item) => total + item.valueHr, 0);
const roundHr = (value: number, digits = 4) => Number(value.toFixed(digits));

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
  const valuationWarnings: WealthReport["valuationWarnings"]["items"] = [];
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
    collectWarnings(characterValues, valuationWarnings, unmatchedItems);

    const equippedHr = roundHr(sumItemValues(characterValues.filter((item) => item.location === "equipped")), 3);
    const inventoryHr = roundHr(sumItemValues(characterValues.filter((item) => isInventoryLocation(item.location))), 3);
    const characterStashHr = roundHr(sumItemValues(characterValues.filter((item) => isCharacterStashLocation(item.location))), 3);
    const stashHr = roundHr(inventoryHr + characterStashHr, 3);

    characterSummaries.push({
      name: character.header.name,
      className: character.header.class,
      level: character.header.level,
      ruleset: classifyRuleset(character, sourceNames),
      equippedHr,
      inventoryHr,
      characterStashHr,
      stashHr,
      totalHr: roundHr(equippedHr + stashHr, 3),
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
      collectWarnings(valuations, valuationWarnings, unmatchedItems);
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

  const totalHr = roundHr(sumItemValues(valuedItems));
  const runeHr = roundHr(sumItemValues(valuedItems.filter(isRuneValuation)));
  const equippedHr = roundHr(sumItemValues(valuedItems.filter((item) => item.location === "equipped")));
  const inventoryHr = roundHr(sumItemValues(valuedItems.filter((item) => isInventoryLocation(item.location))));
  const characterStashHr = roundHr(sumItemValues(valuedItems.filter((item) => isCharacterStashLocation(item.location))));
  const stashHr = roundHr(inventoryHr + characterStashHr);
  const sharedHr = roundHr(sumItemValues(valuedItems.filter((item) => isSharedStashLocation(item.location))));
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
    inventoryHr,
    characterStashHr,
    stashHr,
    sharedHr,
    characters: characterSummaries,
    runeSummary,
    topCharacterStash: valuedItems
      .filter((item) => isCharacterStashLocation(item.location))
      .filter((item) => item.valueHr > 0)
      .sort((left, right) => right.valueHr - left.valueHr)
      .slice(0, 12),
    topInventory: valuedItems
      .filter((item) => isInventoryLocation(item.location))
      .filter((item) => item.valueHr > 0)
      .sort((left, right) => right.valueHr - left.valueHr)
      .slice(0, 12),
    topSharedStash: valuedItems
      .filter((item) => isSharedStashLocation(item.location))
      .filter((item) => !isRuneValuation(item))
      .filter((item) => item.valueHr > 0)
      .sort((left, right) => right.valueHr - left.valueHr)
      .slice(0, 12),
    allValuedItems: valuedItems.sort((left, right) => right.valueHr - left.valueHr),
    unmatchedItems,
    valuationWarnings: {
      totalCount: valuationWarnings.length,
      unresolvedCount: valuationWarnings.filter((warning) => warning.kind === "unresolved").length,
      ambiguousCount: valuationWarnings.filter((warning) => warning.kind === "ambiguous").length,
      items: valuationWarnings,
    },
    snapshot: {
      importedAt,
      totalHr,
      runeHr,
      equippedHr,
      inventoryHr,
      characterStashHr,
      stashHr,
      sharedHr,
      characterCount: characters.length,
    },
  };
};
