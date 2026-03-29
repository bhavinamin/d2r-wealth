import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fixture from "./fixtures/parser-account.fixture.json" with { type: "json" };
import marketData from "../src/generated/market-data.json" with { type: "json" };
import { buildGatewayReport, evaluateItem } from "../gateway/report.mjs";
import { write as writeCharacter, setConstantData } from "@d2runewizard/d2s";
import { write as writeStash } from "@d2runewizard/d2s/lib/d2/stash.js";
import { constants as constants96 } from "@d2runewizard/d2s/lib/data/versions/96_constant_data.js";
import { constants as constants105 } from "@d2runewizard/d2s/lib/data/versions/105_constant_data.js";

setConstantData(96, constants96);
setConstantData(105, constants105);

const menuAppearanceParts = [
  "head",
  "torso",
  "legs",
  "right_arm",
  "left_arm",
  "right_hand",
  "left_hand",
  "shield",
  "special1",
  "special2",
  "special3",
  "special4",
  "special5",
  "special6",
  "special7",
  "special8",
];

const actQuestNames = {
  act_i: [
    "den_of_evil",
    "sisters_burial_grounds",
    "tools_of_the_trade",
    "the_search_for_cain",
    "the_forgotten_tower",
    "sisters_to_the_slaughter",
  ],
  act_ii: [
    "radaments_lair",
    "the_horadric_staff",
    "tainted_sun",
    "arcane_sanctuary",
    "the_summoner",
    "the_seven_tombs",
  ],
  act_iii: [
    "lam_esens_tome",
    "khalims_will",
    "blade_of_the_old_religion",
    "the_golden_bird",
    "the_blackened_temple",
    "the_guardian",
  ],
  act_iv: ["the_fallen_angel", "terrors_end", "hellforge"],
  act_v: [
    "siege_on_harrogath",
    "rescue_on_mount_arreat",
    "prison_of_ice",
    "betrayal_of_harrogath",
    "rite_of_passage",
    "eve_of_destruction",
  ],
};

const waypointNames = {
  act_i: [
    "rogue_encampement",
    "cold_plains",
    "stony_field",
    "dark_woods",
    "black_marsh",
    "outer_cloister",
    "jail_lvl_1",
    "inner_cloister",
    "catacombs_lvl_2",
  ],
  act_ii: [
    "lut_gholein",
    "sewers_lvl_2",
    "dry_hills",
    "halls_of_the_dead_lvl_2",
    "far_oasis",
    "lost_city",
    "palace_cellar_lvl_1",
    "arcane_sanctuary",
    "canyon_of_the_magi",
  ],
  act_iii: [
    "kurast_docks",
    "spider_forest",
    "great_marsh",
    "flayer_jungle",
    "lower_kurast",
    "kurast_bazaar",
    "upper_kurast",
    "travincal",
    "durance_of_hate_lvl_2",
  ],
  act_iv: ["the_pandemonium_fortress", "city_of_the_damned", "river_of_flame"],
  act_v: [
    "harrogath",
    "frigid_highlands",
    "arreat_plateau",
    "crystalline_passage",
    "halls_of_pain",
    "glacial_trail",
    "frozen_tundra",
    "the_ancients_way",
    "worldstone_keep_lvl_2",
  ],
};

const npcNames = [
  "warriv_act_ii",
  "charsi",
  "warriv_act_i",
  "kashya",
  "akara",
  "gheed",
  "greiz",
  "jerhyn",
  "meshif_act_ii",
  "geglash",
  "lysnader",
  "fara",
  "drogan",
  "alkor",
  "hratli",
  "ashera",
  "cain_act_iii",
  "elzix",
  "malah",
  "anya",
  "natalya",
  "meshif_act_iii",
  "ormus",
  "cain_act_v",
  "qualkehk",
  "nihlathak",
];

let fixedImportedAt = fixture.reportImportedAt;
const RealDate = Date;

const createQuest = () => ({
  is_completed: false,
  is_requirement_completed: false,
  is_received: false,
  unk3: false,
  unk4: false,
  unk5: false,
  unk6: false,
  consumed_scroll: false,
  unk8: false,
  unk9: false,
  unk10: false,
  unk11: false,
  closed: false,
  done_recently: false,
  unk14: false,
  unk15: false,
});

const createQuests = () =>
  Object.fromEntries(
    Object.entries(actQuestNames).map(([actName, quests]) => [
      actName,
      {
        introduced: false,
        ...Object.fromEntries(quests.map((questName) => [questName, createQuest()])),
        completed: false,
      },
    ]),
  );

const createWaypoints = () =>
  Object.fromEntries(
    ["normal", "nm", "hell"].map((difficulty) => [
      difficulty,
      Object.fromEntries(
        Object.entries(waypointNames).map(([actName, entries]) => [
          actName,
          Object.fromEntries(entries.map((name) => [name, false])),
        ]),
      ),
    ]),
  );

const createNpcs = () =>
  Object.fromEntries(
    ["normal", "nm", "hell"].map((difficulty) => [
      difficulty,
      Object.fromEntries(npcNames.map((name) => [name, { intro: false, congrats: false }])),
    ]),
  );

const createMenuAppearance = () =>
  Object.fromEntries(menuAppearanceParts.map((part) => [part, { graphic: 0, tint: 0 }]));

const createAttributes = (className, level) => {
  const classData = constants96.classes.find((entry) => entry?.n === className)?.a;
  assert.ok(classData, `Missing class constants for ${className}`);

  return {
    strength: Number(classData.str),
    energy: Number(classData.int),
    dexterity: Number(classData.dex),
    vitality: Number(classData.vit),
    current_hp: Number(classData.vit) + Number(classData.hpadd),
    max_hp: Number(classData.vit) + Number(classData.hpadd),
    current_mana: Number(classData.int),
    max_mana: Number(classData.int),
    current_stamina: Number(classData.stam),
    max_stamina: Number(classData.stam),
    level,
  };
};

const createSkills = (className) => {
  const classCode = constants96.classes.find((entry) => entry?.n === className)?.c;
  assert.ok(classCode, `Missing class code for ${className}`);

  return constants96.skills
    .filter((skill) => skill?.c === classCode)
    .map((skill, index) => ({
      id: index,
      name: skill.s,
      points: 0,
    }));
};

const resolveLocation = (location) => {
  if (location === "equipped") {
    return { location_id: 1, alt_position_id: 0 };
  }

  if (location === "inventory") {
    return { location_id: 0, alt_position_id: 1 };
  }

  return { location_id: 0, alt_position_id: 5 };
};

const baseItem = ({ type, typeName, quality = 2, itemVersion = "101", x = 0, y = 0, location, equippedId = 0 }) => {
  const { location_id, alt_position_id } = resolveLocation(location);

  return {
    identified: 1,
    socketed: 0,
    new: 0,
    is_ear: 0,
    starter_item: 0,
    simple_item: 0,
    ethereal: 0,
    personalized: 0,
    personalized_name: "",
    given_runeword: 0,
    version: itemVersion,
    location_id,
    equipped_id: equippedId,
    position_x: x,
    position_y: y,
    alt_position_id,
    type,
    type_id: 0,
    type_name: typeName,
    quest_difficulty: 0,
    nr_of_items_in_sockets: 0,
    id: 100000 + x * 100 + y,
    level: 90,
    quality,
    multiple_pictures: 0,
    picture_id: 0,
    class_specific: 0,
    low_quality_id: 0,
    timestamp: 0,
    ear_attributes: { class: 0, level: 0, name: "" },
    defense_rating: 0,
    max_durability: 0,
    current_durability: 0,
    total_nr_of_sockets: 0,
    quantity: 0,
    magic_prefix: 0,
    magic_prefix_name: "",
    magic_suffix: 0,
    magic_suffix_name: "",
    runeword_id: 0,
    runeword_name: "",
    runeword_attributes: [],
    set_id: 0,
    set_name: "",
    set_list_count: 0,
    set_attributes: [],
    set_attributes_num_req: 0,
    set_attributes_ids_req: 0,
    rare_name: "",
    rare_name2: "",
    magical_name_ids: [],
    unique_id: 0,
    unique_name: "",
    magic_attributes: [],
    combined_magic_attributes: [],
    socketed_items: [],
    base_damage: { mindam: 0, maxdam: 0, twohandmindam: 0, twohandmaxdam: 0 },
    reqstr: 0,
    reqdex: 0,
    inv_width: 1,
    inv_height: 1,
    inv_file: 0,
    inv_transform: 0,
    transform_color: "",
    item_quality: 0,
    file_index: 0,
    auto_affix_id: 0,
    _unknown_data: {},
    rare_name_id: 0,
    rare_name_id2: 0,
    displayed_magic_attributes: [],
    displayed_runeword_attributes: [],
    displayed_combined_magic_attributes: [],
  };
};

const buildItem = (spec, targetVersion) => {
  switch (spec.template) {
    case "harlequin-crest":
      return {
        ...baseItem({
          type: "uap",
          typeName: "Shako",
          quality: 7,
          itemVersion: targetVersion > 0x61 ? "101" : "101",
          x: spec.x,
          y: spec.y,
          location: spec.location,
          equippedId: spec.equippedId ?? 0,
        }),
        defense_rating: 141,
        max_durability: 12,
        current_durability: 12,
        unique_id: 248,
        unique_name: "Harlequin Crest",
      };
    case "ber-rune":
      return buildMaterialItem(spec, targetVersion, "r30", "Ber Rune");
    case "jah-rune":
      return buildMaterialItem(spec, targetVersion, "r31", "Jah Rune");
    case "ist-rune":
      return buildMaterialItem(spec, targetVersion, "r24", "Ist Rune");
    case "key-of-hatred":
      return buildMaterialItem(spec, targetVersion, "pk2", "Key of Hate");
    case "key-of-terror":
      return buildMaterialItem(spec, targetVersion, "pk1", "Key of Terror");
    case "enigma":
      return {
        ...baseItem({
          type: "utp",
          typeName: "Mage Plate",
          quality: 2,
          itemVersion: targetVersion > 0x61 ? "101" : "101",
          x: spec.x,
          y: spec.y,
          location: spec.location,
          equippedId: spec.equippedId ?? 0,
        }),
        socketed: 1,
        given_runeword: 1,
        runeword_id: 59,
        runeword_name: "Enigma",
        total_nr_of_sockets: 3,
      };
    case "stash-amulet":
      return {
        ...baseItem({
          type: "amu",
          typeName: "Amulet",
          quality: 4,
          itemVersion: targetVersion > 0x61 ? "101" : "101",
          x: spec.x,
          y: spec.y,
          location: spec.location,
          equippedId: spec.equippedId ?? 0,
        }),
        magic_prefix_name: "Shimmering",
      };
    default:
      throw new Error(`Unsupported fixture item template: ${spec.template}`);
  }
};

const buildMaterialItem = (spec, targetVersion, type, typeName) => {
  const item = baseItem({
    type,
    typeName,
    itemVersion: targetVersion > 0x61 ? "101" : "101",
    x: spec.x,
    y: spec.y,
    location: spec.location,
    equippedId: spec.equippedId ?? 0,
  });

  if (typeof spec.stackAmount === "number") {
    item._unknown_data.chest_stackable = 1;
    item.amount_in_shared_stash = spec.stackAmount;
  }

  return item;
};

const createCharacterFile = async (saveDir, character = fixture.character) => {
  const payload = {
    header: {
      identifier: "aa55aa55",
      checksum: "00000000",
      name: character.name,
      status: { expansion: true, died: false, hardcore: false, ladder: false },
      class: character.className,
      created: 0,
      last_played: 0,
      menu_appearance: createMenuAppearance(),
      left_skill: "Attack",
      right_skill: "Attack",
      left_swap_skill: "Attack",
      right_swap_skill: "Attack",
      merc_id: "0",
      assigned_skills: [],
      quests_normal: createQuests(),
      quests_nm: createQuests(),
      quests_hell: createQuests(),
      waypoints: createWaypoints(),
      npcs: createNpcs(),
      version: 96,
      filesize: 0,
      active_arms: 0,
      progression: 0,
      level: character.level,
      difficulty: { Normal: 0, Nightmare: 0, Hell: 0 },
      map_id: 0,
      dead_merc: 0,
      merc_name_id: 0,
      merc_type: 0,
      merc_experience: 0,
    },
    attributes: createAttributes(character.className, character.level),
    item_bonuses: [],
    skills: createSkills(character.className),
    items: character.items.map((item) => buildItem(item, 96)),
    corpse_items: [],
    merc_items: [],
    golem_item: null,
    demon: null,
    is_dead: 0,
  };

  const bytes = await writeCharacter(payload, constants96, { disableItemEnhancements: true });
  await fs.writeFile(path.join(saveDir, character.fileName), Buffer.from(bytes));
};

const createSharedStashFile = async (saveDir, stash = fixture.sharedStash) => {
  const payload = {
    version: "105",
    type: 0,
    pageCount: stash.pages.length,
    sharedGold: 0,
    hardcore: false,
    pages: stash.pages.map((page) => ({
      name: page.name,
      type: 0,
      isStackable: page.isStackable,
      items: page.items.map((item) => buildItem(item, 0x69)),
    })),
  };

  const bytes = await writeStash(payload, constants105, 0x69, { disableItemEnhancements: true });
  await fs.writeFile(path.join(saveDir, stash.fileName), Buffer.from(bytes));
};

const withFixedDate = async (fn) => {
  class MockDate extends RealDate {
    constructor(...args) {
      super(args.length ? args[0] : fixedImportedAt);
    }

    static now() {
      return new RealDate(fixedImportedAt).valueOf();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  }

  globalThis.Date = MockDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

const buildScenarioReport = async ({
  accountDirName = fixture.accountDirName,
  importedAt = fixture.reportImportedAt,
  character = fixture.character,
  sharedStash = fixture.sharedStash,
}) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d2-wealth-parser-fixtures-"));
  const saveDir = path.join(tempRoot, accountDirName);
  await fs.mkdir(saveDir, { recursive: true });

  await createCharacterFile(saveDir, character);
  await createSharedStashFile(saveDir, sharedStash);

  const previousFixedImportedAt = fixedImportedAt;
  fixedImportedAt = importedAt;
  try {
    return await withFixedDate(() => buildGatewayReport(saveDir));
  } finally {
    fixedImportedAt = previousFixedImportedAt;
  }
};

const buildFixtureReport = async () => buildScenarioReport({});

const roundHr = (value) => Number(value.toFixed(4));

const sumHr = (items) => roundHr(items.reduce((total, item) => total + item.valueHr, 0));

const rawSumHr = (items) => items.reduce((total, item) => total + item.valueHr, 0);

const isRuneValuation = (item) => item.matchedBy === "token" && item.name.endsWith(" Rune");

const makeValueTestItem = (overrides = {}) => ({
  unique_name: "",
  set_name: "",
  runeword_name: "",
  given_runeword: 0,
  runeword_id: 0,
  type: "",
  type_name: "",
  total_nr_of_sockets: 0,
  socketed_items: [],
  amount_in_shared_stash: undefined,
  ethereal: 0,
  ...overrides,
});

test("fixture-driven gateway report stays deterministic across character, shared stash, and stackable materials", async () => {
  const report = await buildFixtureReport();
  assert.deepEqual(report, fixture.expectedReport);
});

test("account totals reconcile to equipped, stash, shared stash, and rune-derived values without double counting", async () => {
  const report = await buildFixtureReport();
  const equippedItems = report.allValuedItems.filter((item) => item.location === "equipped");
  const stashItems = report.allValuedItems.filter((item) =>
    ["character-stash", "inventory", "cube"].includes(item.location),
  );
  const sharedItems = report.allValuedItems.filter((item) => ["shared-stash", "private-stash"].includes(item.location));
  const runeItems = sharedItems.filter(isRuneValuation);
  const nonRuneSharedItems = sharedItems.filter((item) => !isRuneValuation(item));

  const equippedHr = sumHr(equippedItems);
  const stashHr = sumHr(stashItems);
  const runeHr = sumHr(runeItems);
  const nonRuneSharedHr = sumHr(nonRuneSharedItems);
  const rawReconciledTotal = rawSumHr(equippedItems) + rawSumHr(stashItems) + rawSumHr(nonRuneSharedItems) + rawSumHr(runeItems);

  assert.equal(report.equippedHr, equippedHr);
  assert.equal(report.stashHr, stashHr);
  assert.equal(report.runeHr, runeHr);
  assert.equal(report.sharedHr, roundHr(nonRuneSharedHr + runeHr));
  assert.equal(report.totalHr, sumHr(report.allValuedItems));
  assert.equal(report.totalHr, roundHr(rawReconciledTotal));

  assert.deepEqual(
    report.topSharedStash.map((item) => item.name),
    nonRuneSharedItems.map((item) => item.name),
  );
  assert.ok(report.topSharedStash.every((item) => !isRuneValuation(item)));
  assert.ok(report.runeSummary.every((entry) => entry.count > 0));
  assert.deepEqual(
    report.runeSummary.map((entry) => entry.name),
    ["Jah", "Ist"],
  );
});

test("rune market keeps key HR conversion anchors stable", () => {
  const { runeValues, tokenValues } = marketData;

  assert.equal(runeValues.Ber, 1);
  assert.equal(runeValues.Jah, 1.25);
  assert.equal(runeValues.Sur, 0.5);
  assert.equal(runeValues.Lo, 0.75);
  assert.equal(runeValues.Vex, 0.5);
  assert.equal(runeValues.Gul, 0.25);
  assert.equal(runeValues.Ist, 0.125);

  assert.equal(runeValues.Ist * 2, runeValues.Gul);
  assert.equal(runeValues.Gul * 2, runeValues.Vex);
  assert.equal(runeValues.Vex * 2, runeValues.Ber);
  assert.equal(runeValues.Sur * 2, runeValues.Ber);

  for (const rune of ["Ber", "Jah", "Sur", "Lo", "Vex", "Gul", "Ist"]) {
    const token = tokenValues[rune.toLowerCase()];
    assert.ok(token, `Expected token market entry for ${rune}`);
    assert.equal(token.kind, "rune");
    assert.equal(token.name, rune);
    assert.equal(token.valueHr, runeValues[rune]);
  }
});

test("pricing contract surfaces explicit source labels for rune, workbook, derived recipe, and unresolved values", () => {
  const derivedItem = evaluateItem(
    makeValueTestItem({
      runeword_name: "Enigma",
      type: "utp",
      type_name: "Mage Plate",
    }),
    "ContractTester",
    "equipped",
    "ContractTester equipped 1",
  );
  const workbookItem = evaluateItem(
    makeValueTestItem({
      type: "pk2",
      type_name: "Key of Hate",
    }),
    "ContractTester",
    "character-stash",
    "ContractTester stash 1",
  );
  const runeItem = evaluateItem(
    makeValueTestItem({
      type: "r24",
      type_name: "Ist Rune",
    }),
    "ContractTester",
    "shared-stash",
    "ContractTester materials 1",
  );
  const unresolvedItem = evaluateItem(
    makeValueTestItem({
      type: "xyz",
      type_name: "Unknown Relic",
    }),
    "ContractTester",
    "character-stash",
    "ContractTester stash 2",
  );

  assert.ok(derivedItem);
  assert.equal(derivedItem.valueSource.type, "derived");
  assert.equal(derivedItem.valueSource.label, "Derived Runeword Recipe");
  assert.match(derivedItem.valueSource.detail ?? "", /Enigma = Jah \+ Ith \+ Ber/);

  assert.ok(workbookItem);
  assert.equal(workbookItem.valueSource.type, "workbook");
  assert.equal(workbookItem.valueSource.label, "Workbook: Endgame Market");
  assert.equal(workbookItem.valueSource.sheet, "Endgame Market");

  assert.ok(runeItem);
  assert.equal(runeItem.valueSource.type, "rune-market");
  assert.equal(runeItem.valueSource.label, "Live Rune Market");

  assert.ok(unresolvedItem);
  assert.equal(unresolvedItem.valueSource.type, "unresolved");
  assert.equal(unresolvedItem.valueSource.label, "Unresolved Market Value");
});
