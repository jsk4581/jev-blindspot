// The gate question set, one systemOne call.
// Rule: only judgments with a closed answer space go to jev. Domain and what
// exactly was not considered are open-ended and belong to the brain.
//
// Two judgments decide: `worth_checking` (would an expert see something the
// author did not think of) and `risk` (how far the work reaches). The four
// gap flags follow the taxonomy in arXiv 2501.11709 and are hints only: they
// become panel chips and brain input, never a decision.
import { noul, score } from "@typesafe-ai/sdk";
import { GAP_KEYS, type GapKey } from "../shared/protocol.js";

const GAP_INSTRUCTIONS: Record<GapKey, string> = {
  missing_context:
    "`prompt` depends on context the author has and did not give: why they want it, what they already tried or observed, or which part of the project (a screen, module, function, table, service) they mean; and neither `history` nor `project` supplies it.",
  missing_specification:
    "Carrying out `prompt` forces a choice with lasting consequences (a library, protocol, storage, data format, auth scheme, or what counts as done) that `prompt` does not make and that the author would want to make themselves rather than have picked for them.",
  unclear_instruction:
    "Two competent assistants given `prompt` and `history` would likely build materially different things, not merely differ in details, because the request can be read in more than one way. This includes a `prompt` that answers the last `assistant` reply in `history` when that reply offered several options or asked several questions and `prompt` does not say which one it accepts.",
  multiple_context:
    "`prompt` asks for two or more separable pieces of work that an expert would plan, review, or deliver separately, and it does not say which comes first or whether they must land together.",
};

export const RISK_LEVELS = [
  "The work implied by `prompt` only reads or explains; nothing in the repository or any running system changes.",
  "The work changes code in a small area and a single git revert would undo it.",
  "The work changes shared code, public interfaces, or configuration that other parts of the project depend on.",
  "The work touches authentication, credentials, personal data, payments, or behaviour that real users will see.",
  "The work does something that cannot be undone, such as deleting data, force pushing, running a production migration, or sending something to real people.",
] as const;

export function buildQuestions() {
  const gaps = Object.fromEntries(GAP_KEYS.map((k) => [k, noul(GAP_INSTRUCTIONS[k])])) as Record<
    GapKey,
    ReturnType<typeof noul>
  >;
  return {
    worth_checking: noul(
      "An expert in the field `prompt` touches, reading it together with `history`, could name something the author did not think to consider and that would change what gets built or decided: a concern, a consequence, a convention, or a choice the author did not know was there. Things the author clearly left out on purpose do not count. A bare acknowledgement, greeting, or 'continue' has nothing to consider, except when the last `assistant` reply in `history` asked a question or offered options and `prompt` does not say which one it accepts.",
    ),
    risk: score("How far can the work implied by `prompt` reach if it goes wrong?", RISK_LEVELS),
    ...gaps,
  };
}

export type GateQuestions = ReturnType<typeof buildQuestions>;
