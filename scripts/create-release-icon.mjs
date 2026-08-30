import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createIcoFromPng } from "../src/release-assets.js";

const root = resolve(import.meta.dirname, "..");
const input = resolve(root, "assets/translive-brand/translive-tray.png");
const output = resolve(root, "assets/translive-brand/translive.ico");

const ico = createIcoFromPng(await readFile(input));
await writeFile(output, ico);
process.stdout.write(`Created ${output}\n`);
