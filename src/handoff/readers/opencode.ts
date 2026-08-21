// Reader for the JSON emitted by `opencode export --sanitize`.
//
// EXPERIMENTAL - the exact shape of this output has NOT been verified against a
// real `opencode export` invocation (AGENTS.md "Adding an adapter", step 4). No
// fixture captured from the real binary exists in this repo, so every key name
// below is a guess drawn from OpenCode's published session model, and the parser
// is written to probe several plausible spellings and to fail loudly rather than
// to fabricate. When someone captures a real export, replace the probe lists
// with the observed keys and tighten the tests.
//
// Same narrowing posture as the other readers: only turn text, session id, cwd
// and model cross the boundary. Tool parts, file attachments, snapshots,
// permissions and provider configuration are dropped, and the drop is reported.
//
// Pure: no filesystem, no spawning, never throws.

import type { DistilledSession } from "../types.js";

/** Keys probed for the session id, in order. */
const SESSION_ID_KEYS: readonly string[] = ["sessionID", "sessionId", "session_id", "id"];
/** Keys probed for the array of messages, in order. */
const MESSAGES_KEYS: readonly string[] = ["messages", "turns", "parts", "entries"];
/** Keys probed for the working directory, in order. */
const CWD_KEYS: readonly string[] = ["cwd", "directory", "worktree", "path", "root"];
/** Keys probed for the model name, in order. */
const MODEL_KEYS: readonly string[] = ["model", "modelID", "model_id"];
/** Containers probed for a nested session object before giving up. */
const NESTED_KEYS: readonly string[] = ["session", "info", "data", "export"];

const PATH_RE = /(?:[A-Za-z]:\\|\/)?(?:[\w.@+-]+[/\\])+[\w.@+-]+\.[A-Za-z0-9]{1,10}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** First non-empty string found at any of `keys` on any of `sources`. */
function probeString(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const found = asString(source[key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/** First array found at any of `keys` on any of `sources`. */
function probeArray(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown[] | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/**
 * Message text under any of the shapes OpenCode might use: a bare `text`, a
 * string `content`, or an array of parts where only `type: "text"` parts count.
 * Everything else - tool parts, files, snapshots, step markers - is dropped.
 */
function extractText(message: Record<string, unknown>): { text: string; dropped: number } {
  const direct = asString(message.text) ?? asString(message.content);
  if (direct !== null) return { text: direct.trim(), dropped: 0 };

  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : null;
  if (parts === null) return { text: "", dropped: 0 };

  const kept: string[] = [];
  let dropped = 0;
  for (const part of parts) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      kept.push(part.text);
      continue;
    }
    dropped += 1;
  }
  return { text: kept.join("\n").trim(), dropped };
}

function extractRole(message: Record<string, unknown>): "user" | "assistant" | null {
  const nested = isRecord(message.info) ? message.info : null;
  const role =
    asString(message.role) ??
    (nested === null ? null : asString(nested.role)) ??
    (isRecord(message.message) ? asString(message.message.role) : null);
  if (role === "assistant" || role === "user") return role;
  return null;
}

export function parseOpencodeExportJson(json: string): DistilledSession {
  const session: DistilledSession = {
    adapter: "opencode",
    sessionId: null,
    cwd: null,
    model: null,
    turns: [],
    filesTouched: [],
    warnings: [],
  };

  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    session.warnings.push("opencode export was not valid JSON; no turns extracted");
    return session;
  }

  // Candidate objects to probe: the root plus one level of plausible nesting.
  const sources: Record<string, unknown>[] = [];
  if (isRecord(root)) {
    sources.push(root);
    for (const key of NESTED_KEYS) {
      const nested = root[key];
      if (isRecord(nested)) sources.push(nested);
    }
  }

  const messages = Array.isArray(root) ? root : probeArray(sources, MESSAGES_KEYS);
  session.sessionId = probeString(sources, SESSION_ID_KEYS);
  session.cwd = probeString(sources, CWD_KEYS);
  session.model = probeString(sources, MODEL_KEYS);

  if (messages === null) {
    session.warnings.push(
      "unrecognised opencode export shape: no message array found (looked for a " +
        `top-level array, or ${MESSAGES_KEYS.join("/")} on the root or on ` +
        `${NESTED_KEYS.join("/")}); no turns extracted`,
    );
    return session;
  }

  const paths = new Set<string>();
  let skipped = 0;
  let droppedParts = 0;

  for (const message of messages) {
    if (!isRecord(message)) {
      skipped += 1;
      continue;
    }
    const role = extractRole(message);
    if (role === null) {
      skipped += 1;
      continue;
    }
    const { text, dropped } = extractText(message);
    droppedParts += dropped;
    if (text.length === 0) continue;
    for (const match of text.matchAll(PATH_RE)) paths.add(match[0]);
    session.turns.push({ role, text });
  }

  if (skipped > 0) {
    session.warnings.push(`skipped ${skipped} message(s) with no recognisable role`);
  }
  if (droppedParts > 0) {
    session.warnings.push(`dropped ${droppedParts} non-text part(s)`);
  }
  session.warnings.push(
    "opencode export shape is unverified; check the brief against the transcript",
  );

  session.filesTouched = [...paths];
  return session;
}

/**
 * argv for `opencode export`. `--sanitize` is mandatory here: the unsanitised
 * export carries provider credentials and full tool output.
 */
export function buildOpencodeExportArgs(sessionId?: string): string[] {
  return ["export", ...(sessionId === undefined ? [] : [sessionId]), "--sanitize"];
}
