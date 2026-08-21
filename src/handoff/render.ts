// Pure renderers for a handoff bundle. No I/O, no spawning, no network.
//
// Everything here treats the transcript as untrusted input: a DistilledSession
// comes from a file written by another process, so every value that reaches the
// HTML is escaped, and the HTML renderer understands only the section structure
// this file itself emits. There is deliberately no general markdown engine -
// an inline-link parser would be a way to smuggle `javascript:` into the page.

import type { DistilledSession, HandoffMeta } from "./types.js";

const BANNER =
  "This brief was distilled mechanically (quoted turns only - no model summarised it). " +
  "Verify every claim against the repo before acting on it.";

/** Sections of the brief, in the order renderHandoffMd emits them. */
export const HANDOFF_SECTIONS: readonly string[] = [
  "Goal",
  "Repo",
  "Files",
  "Done",
  "Open",
  "Next action",
  "Warnings",
];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstTurn(s: DistilledSession, role: "user" | "assistant"): string | null {
  const turn = s.turns.find((t) => t.role === role);
  return turn ? turn.text : null;
}

function lastTurn(s: DistilledSession, role: "user" | "assistant"): string | null {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i]!;
    if (turn.role === role) return turn.text;
  }
  return null;
}

/** Quote text verbatim as a markdown blockquote. Every line is prefixed, so no
 * line of transcript can break out of the quote. */
function quote(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.map((line) => (line.length === 0 ? ">" : `> ${line}`));
}

function quotedSection(text: string | null, emptyNote: string): string[] {
  return text === null || text.trim() === "" ? [`_${emptyNote}_`] : quote(text);
}

function orNone(value: string | null): string {
  return value === null || value === "" ? "(none recorded)" : value;
}

export function renderHandoffMd(s: DistilledSession, meta: HandoffMeta): string {
  const files = dedupeFiles(s);
  const lines: string[] = [];

  lines.push(`# ${meta.title}`);
  lines.push("");
  lines.push(`> ${BANNER}`);
  lines.push("");
  lines.push(`- adapter: ${meta.adapter}`);
  lines.push(`- session: ${orNone(meta.sessionId)}`);
  lines.push(`- model: ${orNone(s.model)}`);
  lines.push(`- created by: ${meta.createdBy}`);
  lines.push(`- created at: ${meta.createdAt}`);
  lines.push(`- turns: ${s.turns.length}`);
  lines.push("");

  lines.push("## Goal");
  lines.push("");
  lines.push("Quoted from the first user turn.");
  lines.push("");
  lines.push(...quotedSection(firstTurn(s, "user"), "The transcript contained no user turn, so the goal is unknown."));
  lines.push("");

  lines.push("## Repo");
  lines.push("");
  lines.push(`- remote: ${orNone(meta.repo.remote)}`);
  lines.push(`- sha: ${orNone(meta.repo.sha)}`);
  lines.push(`- branch: ${orNone(meta.repo.branch)}`);
  lines.push("");

  lines.push("## Files");
  lines.push("");
  if (files.length === 0) {
    lines.push("_No file paths were extracted from the transcript. That means the parser found none, not that nothing changed._");
  } else {
    for (const file of files) lines.push(`- ${file}`);
  }
  lines.push("");

  lines.push("## Done");
  lines.push("");
  lines.push("Quoted from the last assistant turn. It is a claim, not a verified fact.");
  lines.push("");
  lines.push(
    ...quotedSection(
      lastTurn(s, "assistant"),
      "The transcript contained no assistant turn, so nothing is claimed as done.",
    ),
  );
  lines.push("");

  const lastUser = lastTurn(s, "user");

  lines.push("## Open");
  lines.push("");
  lines.push("Quoted from the last user turn - whatever it asked for is the last thing known to be outstanding.");
  lines.push("");
  lines.push(...quotedSection(lastUser, "The transcript contained no user turn, so nothing is recorded as open."));
  lines.push("");

  lines.push("## Next action");
  lines.push("");
  lines.push("The last user turn is the only mechanical signal for what comes next. Re-read it against the repo state above.");
  lines.push("");
  lines.push(...quotedSection(lastUser, "No next action could be extracted. Decide one from the repo state yourself."));
  lines.push("");

  lines.push("## Warnings");
  lines.push("");
  if (s.warnings.length === 0) {
    lines.push("_The parser reported no warnings._");
  } else {
    for (const warning of s.warnings) lines.push(`- ${warning}`);
  }
  lines.push("");

  return lines.join("\n");
}

function dedupeFiles(s: DistilledSession): string[] {
  const seen = new Set<string>();
  for (const file of s.filesTouched) {
    const trimmed = file.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen].sort();
}

export function renderFilesTxt(s: DistilledSession): string {
  const files = dedupeFiles(s);
  if (files.length === 0) return "";
  return `${files.join("\n")}\n`;
}

const STYLE = [
  ":root { color-scheme: light dark; }",
  "* { box-sizing: border-box; }",
  "body { margin: 0; padding: 2rem 1rem 4rem; background: #12141a; color: #e6e8ee;",
  "  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }",
  "main { max-width: 46rem; margin: 0 auto; }",
  "h1 { font-size: 1.6rem; margin: 0 0 1rem; }",
  "h2 { font-size: 1.1rem; margin: 2.25rem 0 .5rem; padding-bottom: .25rem;",
  "  border-bottom: 1px solid #2c3140; text-transform: uppercase; letter-spacing: .06em; }",
  "p { margin: .5rem 0; color: #b9bfd0; }",
  "ul { margin: .5rem 0; padding-left: 1.25rem; }",
  "li { margin: .15rem 0; }",
  "pre { margin: .5rem 0; padding: .75rem 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word;",
  "  background: #1b1f29; border-left: 3px solid #4c5a7a; border-radius: 4px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
  ".banner { margin: 0 0 1.5rem; padding: .75rem 1rem; background: #3a2d12; border: 1px solid #6b5320;",
  "  border-radius: 4px; color: #f0dfae; font-weight: 600; }",
  "footer { margin-top: 3rem; color: #7d8496; font-size: 13px; }",
].join("\n");

/**
 * Render the brief as a fully self-contained index.html: inline CSS only, zero
 * external requests, and every interpolated value escaped.
 *
 * This understands only the structure renderHandoffMd emits - headings, bullet
 * lines, blockquote lines, plain paragraphs - and emits transcript text inside
 * <pre>. Inline markdown is intentionally not interpreted.
 */
export function renderHandoffHtml(handoffMd: string, meta: HandoffMeta): string {
  const body: string[] = [];
  let quoteBuffer: string[] = [];
  let listBuffer: string[] = [];

  const flushQuote = (): void => {
    if (quoteBuffer.length === 0) return;
    const text = quoteBuffer.join("\n");
    // The banner is our own text, emitted by renderHandoffMd as a blockquote.
    // Give it the callout styling instead of a transcript <pre>.
    body.push(
      text === BANNER
        ? `<p class="banner">${escapeHtml(text)}</p>`
        : `<pre>${escapeHtml(text)}</pre>`,
    );
    quoteBuffer = [];
  };
  const flushList = (): void => {
    if (listBuffer.length === 0) return;
    const items = listBuffer.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    body.push(`<ul>${items}</ul>`);
    listBuffer = [];
  };
  const flushAll = (): void => {
    flushQuote();
    flushList();
  };

  for (const raw of handoffMd.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") {
      flushAll();
      continue;
    }
    if (line.startsWith("## ")) {
      flushAll();
      body.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("# ")) {
      flushAll();
      body.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      continue;
    }
    if (line === ">" || line.startsWith("> ")) {
      flushList();
      quoteBuffer.push(line === ">" ? "" : line.slice(2));
      continue;
    }
    if (line.startsWith("- ")) {
      flushQuote();
      listBuffer.push(line.slice(2));
      continue;
    }
    flushAll();
    body.push(`<p>${escapeHtml(stripEmphasis(line))}</p>`);
  }
  flushAll();

  const title = escapeHtml(meta.title);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${title}</title>`,
    `<style>\n${STYLE}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    ...body,
    `<footer>loomgraph handoff v${meta.v} - ${escapeHtml(meta.adapter)} - ${escapeHtml(meta.createdAt)}</footer>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The md uses `_..._` only for our own "nothing here" notes. Strip the markers
 * rather than turning them into markup, so transcript text is never styled. */
function stripEmphasis(line: string): string {
  const match = /^_(.*)_$/.exec(line);
  return match ? match[1]! : line;
}
