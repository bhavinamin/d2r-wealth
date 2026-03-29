import { expect, test } from "@playwright/test";

test("preview dashboard renders the account summary and ledger", async ({ page }) => {
  await page.goto("/?preview=dashboard");

  await expect(page.getByText("Account Net Worth")).toBeVisible();
  await expect(page.getByText("Loot Ledger")).toBeVisible();
  await expect(page.getByText("Preview Account").first()).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();
});
