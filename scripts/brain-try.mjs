// Run the real brain once against this repo (no jev, no daemon). Usage:
//   node scripts/brain-try.mjs "prompt" [--codex]
import { runBrain } from "../dist/src/brain/runner.js";
import { loadConfig } from "../dist/src/shared/config.js";
import { scan } from "../dist/src/context/repo.js";
const prompt = process.argv.slice(2).filter((a) => a !== "--codex").join(" ") || "로그인 기능 만들어줘";
const cfg = { ...loadConfig(), fake: false };
const t0 = Date.now();
const agent = process.argv.includes("--codex") ? "codex" : "claude";
const out = await runBrain({ prompt, cwd: process.cwd(), project: scan(process.cwd()), history: [], agent }, cfg, new AbortController().signal);
console.log(JSON.stringify(out, null, 2));
console.log("elapsed", Date.now() - t0, "ms");
