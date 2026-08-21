// Reader for a Claude Code session transcript (`~/.claude/projects/<enc>/<id>.jsonl`).
//
// This is a narrowing boundary, not a converter. A transcript is untrusted,
// secret-bearing input: it contains tool-result blobs, pasted attachments,
// permission modes, MCP configuration and file snapshots, none of which may
// reach a handoff bundle. Everything not on the small allowlist below is
// dropped, and the drop is surfaced in `warnings` rather than hidden.
//
// The parser is pure: it never reads the filesystem, never spawns anything and
// never throws. A line it cannot understand is skipped with a warning.
//
// `gitBranch` is read but not carried: DistilledSession has no branch field
// (HandoffMeta.repo.branch is gathered from git at pack time), so a branch
// found in the transcript is reported as a warning instead of silently lost.

import type { DistilledSession } from "../types.js";

/**
 * Record types observed in real Claude Code transcripts that carry nothing a
 * handoff needs. Listed so they are dropped quietly instead of inflating the
 * "unknown record types" warning on every parse.
 */
const IGNORED_TYPES: readonly string[] = [
  "system",
  "result",
  "last-prompt",
  "mode",
  "permission-mode",
  "attachment",
  "file-history-snapshot",
  "summary",
  "content-replacement",
  "worktree-state",
  "queue-operation",
  "rate_limit_event",
];

/** `context-collapse-start`, `context-collapse-end`, ... are all ignored. */
const IGNORED_PREFIXES: readonly string[] = ["context-collapse"];

/**
 * Path-shaped tokens: at least one separator and a file extension. Deliberately
 * conservative - a false negative costs a missing line in files.txt, a false
 * positive puts noise in front of a human reviewer.
 */
const PATH_RE = /(?:[A-Za-z]:\\|\/)?(?:[\w.@+-]+[/\\])+[\w.@+-]+\.[A-Za-z0-9]{1,10}/g;

function isIgnoredType(type: string): boolean {
  return (
    IGNORED_TYPES.includes(type) || IGNORED_PREFIXES.some((p) => type.startsWith(p))
  );
}

function collectPaths(text: string, into: Set<string>): void {
  for (const match of text.matchAll(PATH_RE)) into.add(match[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pull only the plain-text blocks out of a Claude message `content`, which is
 * either a bare string or an array of typed blocks. `tool_use`, `tool_result`,
 * `image` and `thinking` blocks are dropped; the count is returned so the
 * caller can say so in a warning.
 */
function extractText(content: unknown): { text: string; dropped: number } {
  if (typeof content === "string") return { text: content, dropped: 0 };
  if (!Array.isArray(content)) return { text: "", dropped: 0 };

  const parts: string[] = [];
  let dropped = 0;
  for (const block of content) {
    if (!isRecord(block)) {
      dropped += 1;
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    dropped += 1;
  }
  return { text: parts.join("\n").trim(), dropped };
}

export function parseClaudeSessionJsonl(jsonl: string): DistilledSession {
  const session: DistilledSession = {
    adapter: "claude",
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
  let droppedBlocks = 0;
  let branch: string | null = null;

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

    session.sessionId ??= asString(record.sessionId);
    session.cwd ??= asString(record.cwd);
    branch ??= asString(record.gitBranch);

    const type = typeof record.type === "string" ? record.type : "";
    if (type !== "user" && type !== "assistant") {
      if (type.length === 0) malformed += 1;
      else if (!isIgnoredType(type)) unknownTypes.add(type);
      continue;
    }

    const message = isRecord(record.message) ? record.message : null;
    if (message === null) {
      malformed += 1;
      continue;
    }
    session.model ??= asString(message.model);

    const role = message.role === "assistant" ? "assistant" : "user";
    const { text, dropped } = extractText(message.content);
    droppedBlocks += dropped;
    if (text.length === 0) continue;

    collectPaths(text, paths);
    session.turns.push({ role, text });
  }

  if (malformed > 0) {
    session.warnings.push(`skipped ${malformed} malformed or unrecognised line(s)`);
  }
  if (unknownTypes.size > 0) {
    session.warnings.push(
      `unknown record types: ${[...unknownTypes].sort().join(", ")}`,
    );
  }
  if (droppedBlocks > 0) {
    session.warnings.push(`dropped ${droppedBlocks} tool-result or non-text block(s)`);
  }
  if (branch !== null) {
    session.warnings.push(
      `transcript git branch "${branch}" not carried; repo branch is recorded at pack time`,
    );
  }

  session.filesTouched = [...paths];
  return session;
}

/**
 * Best-effort encoding of a cwd into the directory name Claude Code uses under
 * `~/.claude/projects/`.
 *
 * WARNING: this encoding is undocumented and version-dependent. It is a
 * discovery hint only - a caller must always accept an explicit session-file
 * path override and print which file it actually chose, so a wrong guess is
 * visible instead of silent.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
