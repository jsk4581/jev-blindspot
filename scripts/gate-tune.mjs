// Ad-hoc question tuning: run candidate instructions over the fixtures and
// print a probability matrix. Usage: node scripts/gate-tune.mjs
import { readFileSync } from "node:fs";
import { TypeSafeClient, noul, score } from "@typesafe-ai/sdk";
import { loadConfig } from "../dist/src/shared/config.js";
import { buildGateState } from "../dist/src/gate/state.js";
import { RISK_LEVELS } from "../dist/src/gate/questions.js";

const cfg = loadConfig();
const client = new TypeSafeClient({ timeout: 4000 });
const fixtureFile = process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`) : new URL("../test/fixtures/prompts.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8"));
const variants = JSON.parse(readFileSync(process.argv[2], "utf8"));
const questions = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, k === "risk" ? score(v, RISK_LEVELS) : noul(v)]));

const rows = [];
for (const f of fixtures) {
  const state = buildGateState({ prompt: f.prompt, cwd: process.cwd(), history: f.history ?? [] });
  const t0 = Date.now();
  const { answers } = await client.systemOne({ state, questions, model: cfg.jevModel });
  const cells = Object.keys(variants).map((k) => (k === "risk" ? (answers[k].score + 1).toFixed(1) : answers[k].noul.toFixed(2)));
  rows.push([f.prompt.slice(0, 22).padEnd(22), ...cells, `${Date.now() - t0}ms`]);
}
console.log(["prompt".padEnd(22), ...Object.keys(variants).map((k) => k.slice(0, 10).padStart(10)), "ms"].join(" "));
for (const r of rows) console.log(r.map((c, i) => (i === 0 ? c : String(c).padStart(10))).join(" "));
