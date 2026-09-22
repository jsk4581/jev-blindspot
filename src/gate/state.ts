// The `state` object sent to jev. Everything in here is user-controlled data;
// judgment criteria live in questions.ts, never in state.
import { detectRepoContext, type RepoContext } from "../context/repo.js";
import { readRecentExchanges, type Exchange } from "../context/transcript.js";

export interface GateState {
  prompt: string;
  history: Exchange[];
  project: RepoContext;
}

const PROMPT_MAX = 6000;

/** `history` given explicitly (tuning, /api/gate) replaces what the transcript would provide. */
export function buildGateState(ev: { prompt: string; cwd: string; transcript_path?: string; history?: Exchange[] }): GateState {
  const prompt = ev.prompt.length > PROMPT_MAX ? ev.prompt.slice(0, PROMPT_MAX) : ev.prompt;
  return {
    prompt,
    history: ev.history ?? readRecentExchanges(ev.transcript_path, 2, ev.prompt),
    project: detectRepoContext(ev.cwd),
  };
}
