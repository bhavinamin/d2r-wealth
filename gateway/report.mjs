import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { read as readCharacter, setConstantData } from "@d2runewizard/d2s";
import { read as readStash } from "@d2runewizard/d2s/lib/d2/stash.js";
import { BitReader } from "@d2runewizard/d2s/lib/binary/bitreader.js";
import { readItem, readItems } from "@d2runewizard/d2s/lib/d2/items.js";
import { constants as constants96 } from "@d2runewizard/d2s/lib/data/versions/96_constant_data.js";
import { constants as constants105 } from "@d2runewizard/d2s/lib/data/versions/105_constant_data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedMarketPath = path.resolve(__dirname, "..", "src", "generated", "market-data.json");
const market = JSON.parse(fs.readFileSync(generatedMarketPath, "utf8"));

setConstantData(96, constants96);
setConstantData(105, constants105);

const armorItems = constants105.armor_items;
const weaponItems = constants105.weapon_items;
const otherItems = constants105.other_items;
const runewords = constants105.runewords;

const ITEM_CONTAINER = {
  inventory: 1,
  cube: 4,
  stash: 5,
};

const runewordRecipes = {
  Black: ["Thul", "Io", "Nef"],
  Enigma: ["Jah", "Ith", "Ber"],
  Fortitude: ["El", "Sol", "Dol", "Lo"],
  Grief: ["Eth", "Tir", "Lo", "Mal", "Ral"],
  Insight: ["Ral", "Tir", "Tal", "Sol"],
  Spirit: ["Tal", "Thul", "Ort", "Amn"],
};

const isRotwEnvironment = (saveDir, files = []) => {
  const haystack = `${saveDir} ${files.map((file) => file.name ?? "").join(" ")}`.toLowerCase();
  return haystack.includes("rotw") || haystack.includes("d2rmm_solo") || haystack.includes("modernsharedstash");
};

const classifyRuleset = (character, saveDir, files) => {
  if (isRotwEnvironment(saveDir, files)) {
    return "ROTW";
  }

  if (character.header?.status?.expansion) {
    return "LoD";
  }

  return "Classic";
};

const normalizeMarketName = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\bkey of hate\b/g, "key of hatred")
    .replace(/\brune\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*=\s*/g, "=")
    .trim();

const canonicalBaseName = (item) => {
  const parts = [item.type_name ?? ""];
  if (!parts[0]) {
    return "";
  }

  parts.push("nor");
  if (item.ethereal) {
    parts.push("eth");
  }
  if (item.total_nr_of_sockets) {
    parts.push(`sock=${item.total_nr_of_sockets}`);
  }
  return parts.join(",");
};

const lookupTypeName = (type) => {
  if (!type) {
    return undefined;
  }

  return armorItems[type]?.n ?? weaponItems[type]?.n ?? otherItems[type]?.n ?? undefined;
};

const lookupRunewordName = (item) => {
  if (item.runeword_name) {
    return item.runeword_name;
  }

  if (!item.given_runeword || typeof item.runeword_id !== "number") {
    return undefined;
  }

  return runewords[item.runeword_id]?.n ?? runewords[item.runeword_id - 459]?.n ?? runewords[item.runeword_id - 2645]?.n;
};

const tokenCandidates = (item) =>
  Array.from(
    new Set(
      [item.unique_name, item.set_name, lookupRunewordName(item), item.type_name, lookupTypeName(item.type), item.type]
        .filter(Boolean)
        .map(String),
    ),
  );

const displayName = (item) =>
  [item.unique_name, item.set_name, lookupRunewordName(item), item.type_name, lookupTypeName(item.type), item.type]
    .find(Boolean)
    ?.toString() ?? "Unknown Item";

const classifyCharacterItem = (item) => {
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

const matchExactValue = (item) => {
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

const matchTokenValue = (item) => {
  for (const name of tokenCandidates(item)) {
    const match = market.tokenValues[normalizeMarketName(name)];
    if (match) {
      return match;
    }
  }

  return null;
};

const isLowConfidenceStoredAccessory = (item, location) => {
  if (location === "equipped") {
    return false;
  }

  return new Set(["amu", "rin", "jew", "cm1", "cm2", "cm3"]).has(item.type);
};

const isSuspiciousParsedItem = (item) => {
  const type = String(item.type ?? "");
  return !/^[a-z0-9]{3}$/i.test(type);
};

const isMaterialLikeToken = (item) => {
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

const stackQuantity = (item) => {
  if (typeof item.amount_in_shared_stash !== "number") {
    return 1;
  }

  if (isMaterialLikeToken(item)) {
    return Math.max(0, item.amount_in_shared_stash);
  }

  return item.amount_in_shared_stash > 0 ? item.amount_in_shared_stash : 1;
};

const evaluateItem = (item, owner, location, source) => {
  const quantity = stackQuantity(item);

  if (isLowConfidenceStoredAccessory(item, location) || (location !== "equipped" && isSuspiciousParsedItem(item))) {
    return {
      id: `${owner}-${source}-${displayName(item)}`,
      name: displayName(item),
      quantity,
      owner,
      location,
      source,
      valueHr: 0,
      matchedBy: "unmatched",
    };
  }

  const resolvedRuneword = lookupRunewordName(item);
  if (resolvedRuneword && runewordRecipes[resolvedRuneword]) {
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
      tradeValue: exactMatch.tradeLabel ?? null,
      matchedBy: "exact",
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
  };
};

const gatherRuneCounts = (items, counts, looseOnly = false) => {
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

const parseChronicleItems = async (chronicleBytes) => {
  if (!chronicleBytes?.length) {
    return [];
  }

  let best = [];

  for (let byteOffset = 0; byteOffset < chronicleBytes.length - 24; byteOffset += 1) {
    const slice = chronicleBytes.slice(byteOffset);
    const reader = new BitReader(Uint8Array.from(slice));
    const parsed = [];

    try {
      for (let i = 0; i < 48 && reader.offset < reader.bits.length - 96; i++) {
        const item = await readItem(reader, 0x69, constants105, { disableItemEnhancements: true });
        const recognized = isMaterialLikeToken(item);
        if (!recognized && parsed.length === 0) {
          break;
        }
        if (!recognized) {
          break;
        }
        parsed.push(item);
      }
    } catch {
    }

    if (parsed.length > best.length) {
      best = parsed;
    }
  }

  return best;
};

const parseStackableSectorItems = async (buffer) => {
  const bytes = Buffer.from(buffer);
  const sectorHeader = Buffer.from([0x55, 0xaa, 0x55, 0xaa]);
  const parsedSectors = [];

  for (let offset = 0; offset < bytes.length - 52; offset += 1) {
    const sectorOffset = bytes.indexOf(sectorHeader, offset);
    if (sectorOffset < 0) {
      break;
    }
    offset = sectorOffset;

    if (bytes.length < sectorOffset + 52) {
      continue;
    }

    const version = bytes.readUInt32LE(sectorOffset + 8);
    const sectorSize = bytes.readUInt32LE(sectorOffset + 16);
    const stackableFlag = bytes.readUInt32LE(sectorOffset + 20);
    if (version !== 0x69 || stackableFlag <= 0 || sectorSize <= 52 || sectorOffset + sectorSize > bytes.length) {
      continue;
    }

    const sectorBody = bytes.slice(sectorOffset + 52, sectorOffset + sectorSize);
    const itemListOffset = sectorBody.indexOf(Buffer.from("JM"));
    if (itemListOffset < 0) {
      continue;
    }

    try {
      const items = await readItems(
        new BitReader(Uint8Array.from(sectorBody.slice(itemListOffset))),
        0x69,
        constants105,
        { disableItemEnhancements: true },
      );
      const materialItems = items.filter((item) => isMaterialLikeToken(item) && stackQuantity(item) > 0);
      if (materialItems.length) {
        parsedSectors.push({ stackableFlag, items: materialItems });
      }
    } catch {
    }
  }

  parsedSectors.sort((left, right) => right.items.length - left.items.length || left.stackableFlag - right.stackableFlag);
  return parsedSectors[0]?.items ?? [];
};

export const buildGatewayReport = async (saveDir) => {
  const importedAt = new Date().toISOString();
  const entries = await fsp.readdir(saveDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const characters = [];
  const stashes = [];

  for (const entry of files) {
    const fullPath = path.join(saveDir, entry.name);
    const buffer = new Uint8Array(await fsp.readFile(fullPath));
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".d2s")) {
      characters.push(await readCharacter(buffer, undefined, { disableItemEnhancements: true }));
    } else if (lower.endsWith(".d2i") || lower.endsWith(".sss") || lower.endsWith(".cst")) {
      stashes.push({
        fileName: entry.name,
        buffer,
        data: await readStash(buffer, undefined, null, { disableItemEnhancements: true }),
      });
    }
  }

  const saveSetId = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        saveDir: path.basename(saveDir).toLowerCase(),
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

  const valuedItems = [];
  const unmatchedItems = [];
  const runeCounts = new Map();
  const characterSummaries = [];

  for (const character of characters) {
    const equippedItems = character.items.filter((item) => classifyCharacterItem(item) === "equipped");
    const stashItems = character.items.filter((item) => classifyCharacterItem(item) === "character-stash");
    const carryItems = character.items.filter((item) => ["inventory", "cube"].includes(classifyCharacterItem(item)));

    gatherRuneCounts(character.items, runeCounts, true);

    const characterValues = [
      ...equippedItems.map((item, index) => evaluateItem(item, character.header.name, "equipped", `${character.header.name} equipped ${index + 1}`)),
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
        .map((item) => ({ owner: item.owner, name: item.name, location: item.location })),
    );

    characterSummaries.push({
      name: character.header.name,
      className: character.header.class,
      level: character.header.level,
      ruleset: classifyRuleset(character, saveDir, files),
      equippedHr: Number(characterValues.filter((item) => item.location === "equipped").reduce((a, b) => a + b.valueHr, 0).toFixed(3)),
      stashHr: Number(characterValues.filter((item) => item.location !== "equipped").reduce((a, b) => a + b.valueHr, 0).toFixed(3)),
    });
  }

  for (const stash of stashes) {
    let materialItems = await parseStackableSectorItems(stash.buffer);
    if (!materialItems.length) {
      materialItems = await parseChronicleItems(stash.data.chronicle?.data ?? []);
    }
    gatherRuneCounts(materialItems, runeCounts, true);

    for (const [pageIndex, page] of stash.data.pages.entries()) {
      const location = stash.data.type === 0 ? "shared-stash" : "private-stash";
      const filteredPageItems = materialItems.length ? page.items.filter((item) => !isMaterialLikeToken(item)) : page.items;

      gatherRuneCounts(filteredPageItems, runeCounts, true);

      const valuations = filteredPageItems.map((item, index) =>
        evaluateItem(item, stash.fileName, location, `${stash.fileName} page ${pageIndex + 1} item ${index + 1}`),
      );

      valuedItems.push(...valuations);
      unmatchedItems.push(
        ...valuations
          .filter((item) => item.matchedBy === "unmatched")
          .map((item) => ({ owner: item.owner, name: item.name, location: item.location })),
      );
    }

    if (materialItems.length) {
      const materialValuations = materialItems.map((item, index) =>
        evaluateItem(item, stash.fileName, "shared-stash", `${stash.fileName} materials ${index + 1}`),
      );
      valuedItems.push(...materialValuations);
    }
  }

  const runeSummary = Array.from(runeCounts.entries())
    .map(([name, counts]) => ({
      name,
      count: counts.count,
      looseCount: counts.looseCount,
      totalHr: Number(((market.runeValues[name] ?? 0) * counts.count).toFixed(4)),
    }))
    .filter((entry) => entry.count > 0)
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
      .filter((item) => !(item.matchedBy === "token" && market.tokenValues[normalizeMarketName(item.name)]?.kind === "rune"))
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
