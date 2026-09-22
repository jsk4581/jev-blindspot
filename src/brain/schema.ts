// Structured output contract for the brain, plus a tolerant parser: the CLI
// enforces the schema on its side, we still normalise defensively.
import type { BrainItem, BrainResult, Severity } from "../shared/protocol.js";

export const BRAIN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language", "domains", "items"],
  properties: {
    language: { type: "string", description: "BCP-47 tag of the request language, e.g. ko or en" },
    domains: {
      type: "array",
      maxItems: 4,
      items: { type: "string", maxLength: 40 },
      description: "The expert lenses you applied to this request, in the request language",
    },
    items: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why", "domain", "severity", "confidence"],
        properties: {
          title: { type: "string", maxLength: 60 },
          why: { type: "string", maxLength: 400 },
          suggestion: { type: "string", maxLength: 600 },
          domain: { type: "string", maxLength: 40 },
          severity: { type: "string", enum: ["note", "worth-asking", "likely-costly"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

/** Same contract for OpenAI-style strict structured output (Codex `--output-schema`):
 *  every property required (nullable where optional), no length/range keywords. */
export const BRAIN_JSON_SCHEMA_STRICT = {
  type: "object",
  additionalProperties: false,
  required: ["language", "domains", "items"],
  properties: {
    language: { type: "string", description: "BCP-47 tag of the request language, e.g. ko or en" },
    domains: {
      type: "array",
      items: { type: "string" },
      description: "At most 4 expert lenses you applied to this request, each under 40 characters, in the request language",
    },
    items: {
      type: "array",
      description: "At most 5 items, most severe first",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why", "suggestion", "domain", "severity", "confidence"],
        properties: {
          title: { type: "string", description: "under 60 characters" },
          why: { type: "string", description: "under 400 characters" },
          suggestion: { type: ["string", "null"], description: "under 600 characters; null when you have nothing concrete" },
          domain: { type: "string", description: "under 40 characters" },
          severity: { type: "string", enum: ["note", "worth-asking", "likely-costly"] },
          confidence: { type: "number", description: "0 to 1" },
        },
      },
    },
  },
} as const;

const SEVERITIES: Severity[] = ["note", "worth-asking", "likely-costly"];
const SEV_RANK: Record<Severity, number> = { "likely-costly": 0, "worth-asking": 1, note: 2 };

/** Parse `claude -p --output-format json` stdout into a BrainResult. */
export function parseBrainOutput(stdout: string): { ok: true; result: BrainResult } | { ok: false; message: string } {
  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    const block = firstBalancedObject(stdout);
    if (!block) return { ok: false, message: "no JSON in brain output" };
    try {
      envelope = JSON.parse(block);
    } catch {
      return { ok: false, message: "brain output is not valid JSON" };
    }
  }
  if (envelope && typeof envelope === "object" && envelope.is_error) {
    return { ok: false, message: String(envelope.result ?? envelope.error ?? "brain reported an error") };
  }
  // With --json-schema the payload is in `structured_output`; fall back to
  // `result` (string or object) for older CLIs.
  let payload: any = envelope?.structured_output ?? envelope?.result ?? envelope;
  if (typeof payload === "string") {
    const s = payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      payload = JSON.parse(s);
    } catch {
      const block = firstBalancedObject(s);
      if (!block) return { ok: false, message: "result is not JSON" };
      try {
        payload = JSON.parse(block);
      } catch {
        return { ok: false, message: "result JSON is malformed" };
      }
    }
  }
  return { ok: true, result: normalise(payload) };
}

export function normalise(p: any): BrainResult {
  const language = typeof p?.language === "string" && p.language ? p.language.slice(0, 12) : "en";
  const domains = Array.isArray(p?.domains)
    ? p.domains.filter((d: unknown) => typeof d === "string" && d.trim()).map((d: string) => d.trim().slice(0, 40)).slice(0, 4)
    : [];
  const items: BrainItem[] = (Array.isArray(p?.items) ? p.items : [])
    .filter((it: any) => it && typeof it.title === "string" && typeof it.why === "string")
    .map((it: any): BrainItem => ({
      title: it.title.trim().slice(0, 60),
      why: it.why.trim().slice(0, 400),
      suggestion: typeof it.suggestion === "string" && it.suggestion.trim() ? it.suggestion.trim().slice(0, 600) : undefined,
      domain: typeof it.domain === "string" && it.domain.trim() ? it.domain.trim().slice(0, 40) : "general",
      severity: SEVERITIES.includes(it.severity) ? it.severity : "note",
      confidence: typeof it.confidence === "number" && Number.isFinite(it.confidence) ? Math.min(1, Math.max(0, it.confidence)) : 0.5,
    }))
    .slice(0, 5)
    .sort((a: BrainItem, b: BrainItem) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.confidence - a.confidence);
  return { language, domains, items };
}

function firstBalancedObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
