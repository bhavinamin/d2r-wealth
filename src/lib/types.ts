export type MarketData = {
  generatedAt: string;
  runeValues: Record<string, number>;
  tokenValues: Record<string, { name: string; valueHr: number; kind: string }>;
  exactValues: Record<string, { name: string; valueHr: number; sheet: string; basis: string; tradeLabel?: string | null }>;
  entries: Array<{ name: string; normalizedName: string; valueHr: number; sheet: string; basis: string; tradeLabel?: string | null }>;
};

export type ItemLocation =
  | "equipped"
  | "inventory"
  | "cube"
  | "character-stash"
  | "shared-stash"
  | "private-stash"
  | "other";

export type ValuedItem = {
  id: string;
  name: string;
  quantity?: number;
  location: ItemLocation;
  owner: string;
  source: string;
  sheet?: string;
  valueHr: number;
  tradeValue?: string | null;
  matchedBy: "exact" | "token" | "socketed" | "unmatched";
};

export type RuneSummary = {
  name: string;
  count: number;
  looseCount: number;
  totalHr: number;
};

export type WealthSnapshot = {
  importedAt: string;
  totalHr: number;
  runeHr: number;
  equippedHr: number;
  stashHr: number;
  sharedHr: number;
  characterCount: number;
};

export type WealthReport = {
  importedAt: string;
  totalHr: number;
  runeHr: number;
  equippedHr: number;
  stashHr: number;
  sharedHr: number;
  characters: Array<{
    name: string;
    className: string;
    level: number;
    ruleset: "Classic" | "LoD" | "ROTW";
    equippedHr: number;
    stashHr: number;
  }>;
  runeSummary: RuneSummary[];
  topCharacterStash: ValuedItem[];
  topInventory: ValuedItem[];
  topSharedStash: ValuedItem[];
  allValuedItems: ValuedItem[];
  unmatchedItems: Array<{ owner: string; name: string; location: ItemLocation }>;
  snapshot: WealthSnapshot;
};
