import { getDatabase } from "./db.mjs";

export const loadMarketDataFromDb = () => {
  const db = getDatabase();
  const runeValues = Object.fromEntries(
    db.prepare("SELECT rune_name, value_hr FROM market_rune_values").all().map((row) => [row.rune_name, row.value_hr]),
  );
  const tokenValues = Object.fromEntries(
    db
      .prepare("SELECT normalized_name, display_name, kind, value_hr FROM market_token_values")
      .all()
      .map((row) => [row.normalized_name, { name: row.display_name, kind: row.kind, valueHr: row.value_hr }]),
  );
  const exactValues = Object.fromEntries(
    db
      .prepare("SELECT normalized_name, display_name, sheet_name, basis, trade_label, value_hr FROM market_exact_values")
      .all()
      .map((row) => [
        row.normalized_name,
        {
          name: row.display_name,
          sheet: row.sheet_name,
          basis: row.basis,
          tradeLabel: row.trade_label,
          valueHr: row.value_hr,
        },
      ]),
  );

  return {
    runeValues,
    tokenValues,
    exactValues,
  };
};
