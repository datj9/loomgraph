// Reader for a Codex CLI rollout transcript (JSONL of `{timestamp, type, payload}`).
//
// Narrowing boundary, same posture as the Claude reader: a transcript is
// untrusted, secret-bearing input. Three things are dropped unconditionally and
// must never reach any output field:
//
//   - `session_meta.payload.base_instructions` - the full system prompt, large,
//     and not the sender's to redistribute.
//   - any `world_state` / `inter_agent_communication*` record - other agents'
//     state, frequently carrying paths and credentials from another session.
//   - `function_call` / `function_call_output` / `reasoning` payloads - tool
//     blobs and hidden reasoning.
//
// Pure: no filesystem, no spawning, never throws. Bad line -> skipped + warning.

import type { DistilledSession } from "../types.js";

const RESTRICTED_TYPE_RE = /^(world_state|inter_agent_communication)/;

const IGNORED_PAYLOAD_TYPES: readonly string[] = [
  "function_call",
  "function_call_output",
  "local_shell_call",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
  "web_search_call",
];

const IGNORED_RECORD_TYPES: readonly string[] = ["compacted", "event_msg", "turn_context"];

const PATH_RE = /(?:[A-Za-z]:\\|\/)?(?:[\w.@+-]+[/\\])+[\w.@+-]+\.[A-Za-z0-9]{1,10}/g;

type Turn = { role: "user" | "assistant"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Codex message content is an array of `{type, text}` blocks
 * (`input_text` / `output_text`), or occasionally a bare string.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

export function parseCodexSessionJsonl(jsonl: string): DistilledSession {
  const session: DistilledSession = {
    adapter: "codex",
    sessionId: null,
    cwd: null,
    model: null,
    turns: [],
    filesTouched: [],
    warnings: [],
  };

  const paths = new Set<string>();
  const unknownTypes = new Set<string>();
  let malformed = 0;
  let restricted = 0;
  let droppedPayloads = 0;

  // `event_msg` mirrors the same user/assistant text that `response_item`
  // carries. Keeping both would duplicate every turn, so response items win and
  // the event stream is only a fallback for transcripts that have none.
  const responseTurns: Turn[] = [];
  const eventTurns: Turn[] = [];

  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(record)) {
      malformed += 1;
      continue;
    }

    const type = typeof record.type === "string" ? record.type : "";
    if (type.length === 0) {
      malformed += 1;
      continue;
    }
    if (RESTRICTED_TYPE_RE.test(type)) {
      restricted += 1;
      continue;
    }

    const payload = isRecord(record.payload) ? record.payload : null;
    const payloadType = payload === null ? "" : (asString(payload.type) ?? "");
    if (RESTRICTED_TYPE_RE.test(payloadType)) {
      restricted += 1;
      continue;
    }

    if (type === "session_meta") {
      if (payload === null) {
        malformed += 1;
        continue;
      }
      // Only these four keys are read. base_instructions, git, originator,
      // cli_version and anything else are left behind on purpose.
      session.sessionId ??= asString(payload.id);
      session.cwd ??= asString(payload.cwd);
      session.model ??= asString(payload.model);
      continue;
    }

    if (type === "turn_context") {
      if (payload !== null) {
        session.cwd ??= asString(payload.cwd);
        session.model ??= asString(payload.model);
      }
      continue;
    }

    if (type === "response_item") {
      if (payload === null) {
        malformed += 1;
        continue;
      }
      if (payloadType !== "message") {
        if (IGNORED_PAYLOAD_TYPES.includes(payloadType)) droppedPayloads += 1;
        else unknownTypes.add(`response_item.${payloadType || "(none)"}`);
        continue;
      }
      const text = extractText(payload.content);
      if (text.length === 0) continue;
      const role = payload.role === "assistant" ? "assistant" : "user";
      responseTurns.push({ role, text });
      continue;
    }

    if (type === "event_msg") {
      if (payload === null) {
        malformed += 1;
        continue;
      }
      const text = asString(payload.message);
      if (text === null) continue;
      if (payloadType === "user_message") eventTurns.push({ role: "user", text });
      else if (payloadType === "agent_message")
        eventTurns.push({ role: "assistant", text });
      continue;
    }

    if (!IGNORED_RECORD_TYPES.includes(type)) unknownTypes.add(type);
  }

  session.turns = responseTurns.length > 0 ? responseTurns : eventTurns;
  for (const turn of session.turns) {
    for (const match of turn.text.matchAll(PATH_RE)) paths.add(match[0]);
  }

  if (malformed > 0) {
    session.warnings.push(`skipped ${malformed} malformed or unrecognised line(s)`);
  }
  if (restricted > 0) {
    session.warnings.push(
      `dropped ${restricted} world_state/inter_agent_communication record(s)`,
    );
  }
  if (droppedPayloads > 0) {
    session.warnings.push(`dropped ${droppedPayloads} tool-call or reasoning payload(s)`);
  }
  if (unknownTypes.size > 0) {
    session.warnings.push(
      `unknown record types: ${[...unknownTypes].sort().join(", ")}`,
    );
  }
  if (responseTurns.length > 0 && eventTurns.length > 0) {
    session.warnings.push(
      "event_msg turns dropped as duplicates of response_item turns",
    );
  }

  session.filesTouched = [...paths];
  return session;
}
