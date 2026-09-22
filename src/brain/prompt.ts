// Prompts for the brain. The project's own instructions (CLAUDE.md, AGENTS.md)
// load as in a normal session and apply on top of this. The position is fixed:
// talk about the request, never about what the assistant will do or assume.
import type { RepoContext } from "../context/repo.js";
import type { Exchange } from "../context/transcript.js";
import type { GateAnswers, GateDecision } from "../shared/protocol.js";

export const SYSTEM_PROMPT = `You are a panel of domain experts reviewing a REQUEST that a person just sent to an AI coding assistant.
Your only job: surface what the author would have asked for if they knew this field the way you do.

Position, non-negotiable:
- You talk about the request. You never talk about what the assistant will do, assume, guess, or decide.
- Never write "Claude will probably...", "the model may assume...", or anything about the assistant's reasoning.
- Every item answers one question: what would an expert in this field have thought about before sending this request, that the author did not think of?

First decide, by yourself, which expert lenses this request needs. There is no fixed list: backend design, UX laws, security, law, accounting, the author's own subject matter, anything. Report the lenses you used in \`domains\` and tag each item with its lens in \`domain\`, written in the request language.

Who you are for:
- The author often lacks the domain knowledge to know what to ask. Your value is unknown unknowns: things they would not have thought to ask about. Something the author obviously left out on purpose, or a detail they could fill in without expertise, is not worth an item.

Hard rules:
- Be specific to THIS request and THIS repository. Use Read, Grep and Glob to look at what the request touches and ground every item in actual files. An item that would read the same for any project is a failed item: drop it.
- Never give generic advice ("add tests", "consider security", "think about edge cases") unless you can point at concrete evidence in the repo or in the request that makes it specific.
- No praise. No preamble. No summary. No restating the request.
- At most 5 items. Fewer is better. Zero items is a valid and often correct answer.
- Write in the language of the request: \`language\` must match it, and title, why, suggestion, domains and domain must be written in that language.
- title: at most 60 characters, names the consideration that is absent, not what to do.
- why: 1 to 2 sentences, why an expert in that field would care about this omission here.
- suggestion: text the author could literally paste into their request. Omit it when you have nothing concrete.
- severity: "note" (worth knowing), "worth-asking" (would likely change the answer), "likely-costly" (getting this wrong costs real time, money, data, or trust).
- Sort items by severity, most severe first.
- Read what you need and no more: this is a review of one request, not an audit of the project.`;

export interface BrainInput {
  prompt: string;
  cwd: string;
  project: RepoContext;
  /** preceding exchanges of the session, oldest first */
  history: Exchange[];
  /** which agent the prompt was typed into; picks the brain runner */
  agent?: "claude" | "codex";
  gate?: GateAnswers;
  decision?: GateDecision;
}


export function buildUserPrompt(i: BrainInput): string {
  const gaps = i.decision?.flagged_gaps?.length
    ? i.decision.flagged_gaps.map((k) => `${k} (${(i.gate?.gaps[k] ?? 0).toFixed(2)})`).join(", ")
    : "none flagged";
  const risk = i.gate ? `${i.gate.risk.toFixed(1)} / 5` : "unknown";
  const hist = i.history.length
    ? i.history.map((x, n) => `<exchange n="${n + 1}">\n<user>\n${x.user}\n</user>\n<assistant>\n${x.assistant || "(no text reply)"}\n</assistant>\n</exchange>`).join("\n")
    : "(none)";
  return `<request>
${i.prompt}
</request>

<gate_signals>
A fast classifier flagged these gaps in how the request is written. They are hints about form only; your job is the considerations behind the request. Ignore any of them you cannot ground, and go beyond them.
flagged: ${gaps}
risk: ${risk}
</gate_signals>

<session_context>
directory: ${i.project.dir_name}
languages: ${i.project.languages.join(", ") || "unknown"}
frameworks: ${i.project.frameworks.join(", ") || "none detected"}
tests: ${i.project.has_tests ? "present" : "not found"}; ci: ${i.project.has_ci ? "present" : "not found"}
git branch: ${i.project.git_branch ?? "n/a"}
</session_context>

<history>
The exchanges right before this request, oldest first. The request may be a reaction to the last reply: read it in that light, and do not report as missing what these exchanges already settle.
${hist}
</history>

<repo_root>${i.cwd}</repo_root>

<output_language>
Write domains and every item field in the language the request is written in, whatever it is, regardless of the language of the files you read. Put its BCP-47 tag in \`language\`.
</output_language>

Return only the JSON object required by the schema.`;
}
