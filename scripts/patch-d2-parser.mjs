import fs from "node:fs";
import path from "node:path";

const d2Dir = path.join(process.cwd(), "node_modules", "@d2runewizard", "d2s", "lib", "d2");
const itemsTarget = path.join(d2Dir, "items.js");
const stashTarget = path.join(d2Dir, "stash.js");

if (!fs.existsSync(itemsTarget) || !fs.existsSync(stashTarget)) {
  console.log("d2 parser patch skipped: target not found");
  process.exit(0);
}

const patchFile = (target, mutator) => {
  const source = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  const patched = mutator(source);
  if (patched !== source) {
    fs.writeFileSync(target, patched);
    return true;
  }

  return false;
};

const itemsPatched = patchFile(itemsTarget, (source) => {
  let patched = source;

  if (!patched.includes("skipMagicProps = true;")) {
    patched = patched.replace(
      "function _readMagicProperties(reader, constants, skipMagicProps) {\n",
      "function _readMagicProperties(reader, constants, skipMagicProps) {\n    skipMagicProps = true;\n",
    );
  }

  patched = patched.replace(
    "        throw new Error(`Mercenary header 'jf' not found at position ${reader.offset - 2 * 8}`);\n",
    "        return;\n",
  );

  patched = patched.replace(
    "        throw new Error(`Golem header 'kf' not found at position ${reader.offset - 2 * 8}`);\n",
    "        return;\n",
  );

  patched = patched.replace(
    "        throw new Error(`Corpse header 'JM' not found at position ${reader.offset - 2 * 8}`);\n",
    "        char.is_dead = 0;\n        return;\n",
  );

  if (!patched.includes("Skipping unknown stat id")) {
    patched = patched.replace(
      '        if (id > constants.magical_properties.length) {\n            throw new Error(`Invalid Stat Id: ${id} at position ${reader.offset - 9}`);\n        }\n',
      '        if (id > constants.magical_properties.length) {\n' +
        '            const bitStr = reader.bits.join("");\n' +
        '            const marker = "111111111";\n' +
        '            const idx = bitStr.indexOf(marker, reader.offset);\n' +
        '            if (idx !== -1) {\n' +
        '                reader.SeekBit(idx + 9);\n' +
        '            }\n' +
        '            return magic_attributes;\n' +
        '        }\n',
    );
  }

  patched = patched.replace('            console.warn("0x1FF end marker not found, skipping failed");\n', "");

  if (!patched.includes("const marker1 = \"000000001000010001010000\";")) {
    patched = patched.replace(
      "    const count = reader.ReadUInt16(); //0x0002\n    for (let i = 0; i < count; i++) {\n        /*if (version === 0x69) {\n          const bitStr = reader.bits.join(\"\");\n          const searchStart = reader.offset;\n          const marker1 = \"000000001 00001000 10100000\".replace(/ /g, \"\"); // search for next item\n          const marker2 = \"000000001 00000000 10100000\".replace(/ /g, \"\"); // search for next item\n          const id1 = bitStr.indexOf(marker1, searchStart);\n          const id2 = bitStr.indexOf(marker2, searchStart);\n          const id = id1 !== -1 && id2 !== -1 ? Math.min(id1, id2) : Math.max(id1, id2);\n          reader.SeekBit(id - 15);\n        }*/\n        items.push(await readItem(reader, version, constants, config));\n    }\n",
      "    const count = reader.ReadUInt16(); //0x0002\n    const bitStr = version === 0x69 ? reader.bits.join(\"\") : null;\n    for (let i = 0; i < count; i++) {\n        if (version === 0x69 && i > 0 && bitStr) {\n            const searchStart = reader.offset;\n            const marker1 = \"000000001000010001010000\";\n            const marker2 = \"000000001000000010100000\";\n            const id1 = bitStr.indexOf(marker1, searchStart);\n            const id2 = bitStr.indexOf(marker2, searchStart);\n            const id = id1 !== -1 && id2 !== -1 ? Math.min(id1, id2) : Math.max(id1, id2);\n            if (id !== -1) {\n                reader.SeekBit(id - 15);\n            }\n        }\n        items.push(await readItem(reader, version, constants, config));\n    }\n",
    );
  }

  return patched;
});

const stashPatched = patchFile(stashTarget, (source) => {
  let patched = source;

  patched = patched.replace(
    "        while (reader.offset < reader.bits.length && pageCount < 6) {\n            const pageIndex = pageCount;\n            pageCount++;\n            await readStashHeader(stash, reader, pageIndex);\n            const saveVersion = version || parseInt(stash.version);\n            if (!constants) {\n                constants = constants_1.getConstantData(saveVersion);\n            }\n            await readStashPart(stash, reader, saveVersion, constants, pageIndex);\n        }\n",
    "        while (reader.offset < reader.bits.length && pageCount < 6) {\n            const pageIndex = pageCount;\n            try {\n                await readStashHeader(stash, reader, pageIndex);\n            }\n            catch (_error) {\n                break;\n            }\n            pageCount++;\n            const saveVersion = version || parseInt(stash.version);\n            if (!constants) {\n                constants = constants_1.getConstantData(saveVersion);\n            }\n            await readStashPart(stash, reader, saveVersion, constants, pageIndex);\n        }\n",
  );

  patched = patched.split("    attribute_enhancer_1.enhanceItems(page.items, constants, 1);\n").join("");

  return patched;
});

if (!itemsPatched && !stashPatched) {
  console.log("d2 parser patch already applied");
  process.exit(0);
}

console.log("Applied d2 parser compatibility patch");
