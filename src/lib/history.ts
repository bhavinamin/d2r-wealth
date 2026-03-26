import type { WealthSnapshot } from "./types.js";

const HISTORY_KEY = "d2-wealth-history-v1";

export const loadHistory = (): WealthSnapshot[] => {
  const raw = localStorage.getItem(HISTORY_KEY);
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw) as WealthSnapshot[];
  } catch {
    return [];
  }
};

export const pushHistory = (snapshot: WealthSnapshot): WealthSnapshot[] => {
  const existing = loadHistory();
  const sameAsLast =
    existing.length > 0 &&
    existing[existing.length - 1].totalHr === snapshot.totalHr &&
    existing[existing.length - 1].characterCount === snapshot.characterCount;

  const next = sameAsLast ? existing : [...existing, snapshot].slice(-120);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
};
