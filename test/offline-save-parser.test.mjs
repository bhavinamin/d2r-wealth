import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import expectedParsedSave from "./fixtures/real-save-account/parsed-save.fixture.json" with { type: "json" };
import { parseOfflineSaveData } from "../gateway/report.mjs";

const realSaveFixtureDir = path.resolve("test/fixtures/real-save-account");

test("real offline save fixtures parse character and shared stash data accurately", async () => {
  const parsed = await parseOfflineSaveData(realSaveFixtureDir);
  assert.deepEqual(parsed, expectedParsedSave);

  assert.equal(parsed.characters.length, 1);
  assert.equal(parsed.characters[0].name, "atti");
  assert.equal(parsed.characters[0].className, "Sorceress");
  assert.equal(parsed.characters[0].level, 88);
  assert.deepEqual(
    parsed.characters[0].equippedItems.map((item) => item.name),
    ["Enigma", "Harlequin Crest", "Eschuta's Temper"],
  );

  assert.equal(parsed.stashes.length, 1);
  assert.equal(parsed.stashes[0].kind, "shared");
  assert.equal(parsed.stashes[0].pages[0].items.length, 10);
  assert.equal(parsed.stashes[0].materialItems.length, 49);
});

test("real offline save fixture parsing stays deterministic across repeated runs", async () => {
  const first = await parseOfflineSaveData(realSaveFixtureDir);
  const second = await parseOfflineSaveData(realSaveFixtureDir);
  assert.deepEqual(first, second);
});
