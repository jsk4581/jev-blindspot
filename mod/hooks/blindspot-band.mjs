// jev-blindspot band: a summary of the last prompt's blind spots, above the prompt.
//
// The jev-blindspot hook already sends every prompt to the local daemon; this mod
// only reads the result back and draws it. It never changes a prompt and adds
// nothing to what Claude reads.
//
// prompt.submit: note that a prompt went out, so the band shows "checking" at
//   once and the poll below runs until that prompt's turn settles.
// session.start: read the port and panel address, show the session's last turn,
//   and start the poll.
// ui.render (AbovePrompt): one header line, then the deeper question and every
//   finding, each cut to one row. Other mods' band content is kept below ours.
//
// The host reads on(...) and $.noun.method(...) from source, so they are spelled
// literally, and helpers that take $ are top-level functions.

const POLL_MS = 1500;
// Stop polling a prompt whose turn never settles (daemon down, brain stuck).
const ACTIVE_LIMIT_MS = 180_000;
// The hook stamps the turn when it runs, which may be a little before this mod
// sees the prompt; a turn this much older than the submit still counts as it.
const SUBMIT_SLACK_MS = 5000;
const SETTLED = new Set(["quiet", "gate_unavailable", "done", "error", "cancelled"]);
const GAP_LABEL = {
  missing_context: "context",
  missing_specification: "spec",
  unclear_instruction: "unclear",
  multiple_context: "several asks",
  deeper_problem: "deeper",
};
const SEVERITY = {
  "likely-costly": { mark: "!", color: "red" },
  "worth-asking": { mark: "?", color: "yellow" },
  note: { mark: "·", color: undefined },
};

let disabled = false;
let base = "http://127.0.0.1:7461";
let panelUrl = "http://127.0.0.1:7461/";
let sessionId = null;
// What the band shows: null (nothing), or { turn } / { pending: true }.
let view = null;
let submittedAt = 0;
let polling = false;
let unreachableSince = 0;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    try {
      if ((await $.env.get("JEV_BLINDSPOT_CHILD")) === "1" || (await $.env.get("JEV_BLINDSPOT_DISABLE")) === "1") {
        disabled = true;
        return result;
      }
      await readConfig($);
      sessionId = await $.session.id();
      const turn = await latestTurn($);
      if (turn) view = { turn };
      $.ui.invalidate("ui.render");
      $.clock.every(POLL_MS, () => poll($));
    } catch {
      // the band stays empty
    }
    return result;
  });

  on("prompt.submit", async ($, e, next) => {
    // Only prompts a person sent: not claude -p runs, task notifications or other sessions.
    const kind = e.origin?.kind;
    if (!disabled && (kind === "composer" || kind === "bridge") && !isCommand(e.text)) {
      submittedAt = await $.clock.now();
      unreachableSince = 0;
      view = { pending: true };
      $.ui.invalidate("ui.render");
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (disabled || view === null || e.props?.hasSurvey || e.props?.view?.agentId) {
      return next(e);
    }
    const { Box, Text, Link } = $.ui.resolve(e);
    const ours = band(Box, Text, Link);
    const theirs = await next(e);
    return Box({ flexDirection: "column", children: theirs ? [ours, theirs] : [ours] });
  });
}

async function poll($) {
  if (disabled || submittedAt === 0 || polling) return;
  const now = await $.clock.now();
  if (now - submittedAt > ACTIVE_LIMIT_MS) {
    submittedAt = 0;
    if (view?.pending) view = null;
    $.ui.invalidate("ui.render");
    return;
  }
  polling = true;
  try {
    const turn = await latestTurn($);
    if (turn === undefined) {
      // daemon not answering; the hook starts it, so give it a few seconds
      if (unreachableSince === 0) unreachableSince = now;
      if (now - unreachableSince > 6000) view = { unreachable: true };
    } else if (turn && turn.ts >= submittedAt - SUBMIT_SLACK_MS) {
      unreachableSince = 0;
      view = { turn };
      if (SETTLED.has(turn.state)) submittedAt = 0;
    }
    $.ui.invalidate("ui.render");
  } finally {
    polling = false;
  }
}

/** The session's newest turn, null when it has none, undefined when the daemon is down. */
async function latestTurn($) {
  if (!sessionId) return null;
  try {
    const res = await $.http.fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}?limit=1`);
    if (!res.ok) return undefined;
    const turns = JSON.parse(res.text);
    return Array.isArray(turns) && turns.length ? turns[turns.length - 1] : null;
  } catch {
    return undefined;
  }
}

/** Port and panel address, from the environment or ~/.config/jev-blindspot/env, as the hook reads them. */
async function readConfig($) {
  const file = {};
  try {
    const home = await $.env.get("HOME");
    const cfgHome = (await $.env.get("XDG_CONFIG_HOME")) || `${home}/.config`;
    const text = await $.fs.read(`${cfgHome}/jev-blindspot/env`);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (!line || line.startsWith("#") || eq <= 0) continue;
      file[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no config file
  }
  const port = Number((await $.env.get("JEV_PORT")) || file.JEV_PORT) || 7461;
  const extra = ((await $.env.get("JEV_BIND_EXTRA")) ?? file.JEV_BIND_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  base = `http://127.0.0.1:${port}`;
  panelUrl = `http://${extra[0] ?? "127.0.0.1"}:${port}/`;
}

function isCommand(text) {
  return /^\s*\//.test(String(text ?? ""));
}

function band(Box, Text, Link) {
  const pad = (rows) => Box({ key: "band", flexDirection: "column", paddingX: 1, children: rows });
  const head = (mark, color, words, extra = []) =>
    Box({
      key: "head",
      flexDirection: "row",
      children: [
        Text({ key: "mark", color, bold: true, children: `${mark} blindspot  ` }),
        Text({ key: "words", color, children: words }),
        ...extra,
        Text({ key: "sep", dimColor: true, children: "   " }),
        Link({ key: "link", href: panelUrl, label: panelUrl }),
      ],
    });

  if (view.pending) return pad([head("◌", "cyan", "checking…")]);
  if (view.unreachable) return pad([head("·", undefined, "daemon not reachable")]);

  const t = view.turn;
  const risk = t.gate ? Text({ key: "risk", dimColor: true, children: `  risk ${t.gate.risk.toFixed(1)}` }) : null;
  const flagged = (t.gate_decision?.flagged_gaps ?? []).map((k) => GAP_LABEL[k] ?? k);
  const chips = flagged.length ? Text({ key: "gaps", dimColor: true, children: `  · ${flagged.join(", ")}` }) : null;
  const extras = [risk, chips].filter(Boolean);

  switch (t.state) {
    case "pending":
      return pad([head("◌", "cyan", "checking…")]);
    case "analyzing":
      return pad([head("◌", "cyan", "looking for blind spots…", extras)]);
    case "quiet":
      return pad([head("·", undefined, t.gate_decision?.reason === "duplicate" ? "same prompt, skipped" : "nothing to check", extras)]);
    case "gate_unavailable":
      return pad([head("·", "yellow", `gate unavailable${t.gate_failure ? ` (${t.gate_failure})` : ""}`)]);
    case "error":
      return pad([head("×", "red", `${t.error?.stage ?? "analysis"} failed`)]);
    case "cancelled":
      return pad([head("·", undefined, "cancelled")]);
  }

  // done
  const items = t.result?.items ?? [];
  const deeper = t.result?.deeper?.[0];
  if (items.length === 0 && !deeper) return pad([head("✓", "green", "no blind spots", extras)]);
  const count = `${items.length} blind spot${items.length === 1 ? "" : "s"}`;
  const rows = [head("◉", "magenta", count, extras)];
  if (deeper) {
    rows.push(
      Text({ key: "deeper", wrap: "truncate-end", children: [Text({ key: "dl", color: "magenta", children: "  ↳ deeper  " }), Text({ key: "dt", children: deeper.title })] }),
    );
  }
  // Every finding is shown (the brain returns at most five); a band taller than
  // the terminal allows scrolls.
  for (const [i, it] of items.entries()) {
    const s = SEVERITY[it.severity] ?? SEVERITY.note;
    rows.push(
      Text({ key: `i${i}`, wrap: "truncate-end", children: [Text({ key: "m", color: s.color, bold: true, children: `  ${s.mark} ` }), Text({ key: "t", children: it.title }), Text({ key: "d", dimColor: true, children: `  ${it.domain}` })] }),
    );
  }
  return pad(rows);
}
