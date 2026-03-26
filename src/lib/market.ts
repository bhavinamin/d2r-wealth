import marketData from "../generated/market-data.json";
import type { MarketData } from "./types.js";

export const market = marketData as MarketData;

export const normalizeMarketName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\bkey of hate\b/g, "key of hatred")
    .replace(/\brune\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*=\s*/g, "=")
    .trim();

export const canonicalBaseName = (item: {
  type_name?: string;
  ethereal?: number;
  total_nr_of_sockets?: number;
}) => {
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
