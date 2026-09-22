#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "dist", "src", "cli", "index.js");
if (!existsSync(entry)) {
  console.error("jev-blindspot: build missing. Run `npm run build` in " + resolve(here, ".."));
  process.exit(1);
}
await import(entry);
