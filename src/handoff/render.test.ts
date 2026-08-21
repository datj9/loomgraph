import { describe, expect, it } from "vitest";

import { HANDOFF_SECTIONS, renderFilesTxt, renderHandoffHtml, renderHandoffMd } from "./render.js";
import type { DistilledSession, HandoffMeta } from "./types.js";

const meta: HandoffMeta = {
  v: 1,
  adapter: "claude",
  sessionId: "sess-1",
  title: "handoff: fix the budget guard",
  createdBy: "dat",
  createdAt: "2026-08-21T09:00:00.000Z",
  // Deliberately an ssh remote: the html must contain no resource url at all,
  // and an https remote would make that assertion meaningless.
  repo: { remote: "git@github.com:dat/loomgraph.git", sha: "b0a4162", branch: "feat/handoff" },
};

const session: DistilledSession = {
  adapter: "claude",
  sessionId: "sess-1",
  cwd: "<repo>",
  model: "claude-opus-5",
  turns: [
    { role: "user", text: "make the budget guard fail closed" },
    { role: "assistant", text: "changed checkBudget so it throws" },
    { role: "user", text: "now add a test for the zero-budget case" },
  ],
  filesTouched: ["src/core/budget.ts", "src/core/engine.ts"],
  warnings: ["2 tool-result blocks were unparsed"],
};

const emptySession: DistilledSession = {
  adapter: "codex",
  sessionId: null,
  cwd: null,
  model: null,
  turns: [],
  filesTouched: [],
  warnings: [],
};

describe("renderHandoffMd", () => {
  it("emits every section", () => {
    const md = renderHandoffMd(session, meta);
    for (const section of HANDOFF_SECTIONS) {
      expect(md).toContain(`## ${section}`);
    }
    expect(HANDOFF_SECTIONS).toEqual(["Goal", "Repo", "Files", "Done", "Open", "Next action", "Warnings"]);
  });

  it("emits the sections in the documented order", () => {
    const md = renderHandoffMd(session, meta);
    const offsets = HANDOFF_SECTIONS.map((section) => md.indexOf(`## ${section}`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("quotes the first user turn as the goal and the last assistant turn as done", () => {
    const md = renderHandoffMd(session, meta);
    const goal = md.slice(md.indexOf("## Goal"), md.indexOf("## Repo"));
    const done = md.slice(md.indexOf("## Done"), md.indexOf("## Open"));
    const next = md.slice(md.indexOf("## Next action"), md.indexOf("## Warnings"));
    expect(goal).toContain("> make the budget guard fail closed");
    expect(done).toContain("> changed checkBudget so it throws");
    expect(next).toContain("> now add a test for the zero-budget case");
  });

  it("prints remote, sha and branch under Repo", () => {
    const repo = renderHandoffMd(session, meta);
    expect(repo).toContain("- remote: git@github.com:dat/loomgraph.git");
    expect(repo).toContain("- sha: b0a4162");
    expect(repo).toContain("- branch: feat/handoff");
  });

  it("carries a banner saying the brief was distilled mechanically", () => {
    expect(renderHandoffMd(session, meta)).toMatch(/distilled mechanically/i);
  });

  it("lists files and warnings", () => {
    const md = renderHandoffMd(session, meta);
    expect(md).toContain("- src/core/budget.ts");
    expect(md).toContain("- 2 tool-result blocks were unparsed");
  });

  it("says an empty section is empty instead of omitting the heading", () => {
    const md = renderHandoffMd(emptySession, { ...meta, adapter: "codex", sessionId: null });
    for (const section of HANDOFF_SECTIONS) {
      expect(md).toContain(`## ${section}`);
    }
    expect(md).toContain("no user turn");
    expect(md).toContain("no assistant turn");
    expect(md).toContain("No file paths were extracted");
    expect(md).toContain("no warnings");
    expect(md).toContain("- session: (none recorded)");
    expect(md).toContain("- model: (none recorded)");
  });

  it("keeps a blank transcript line inside the quote so it cannot break out", () => {
    const md = renderHandoffMd(
      { ...session, turns: [{ role: "user", text: "first\n\n## Warnings\nsecond" }] },
      meta,
    );
    expect(md).toContain("> first");
    expect(md).toContain("> ## Warnings");
    expect(md).toContain("> second");
    // The injected heading is quoted, so only the real heading is a heading.
    expect(md.match(/^## Warnings$/gm)).toHaveLength(1);
  });
});

/** Every real tag in the document - escaped text nodes cannot appear here,
 * because escaping leaves them without a literal `<`. */
function tagsOf(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? [];
}

describe("renderHandoffHtml", () => {
  const hostile: DistilledSession = {
    ...session,
    turns: [
      { role: "user", text: '<script>alert(1)</script> & "quoted" \'single\'' },
      { role: "assistant", text: '<img src=x onerror="alert(2)">' },
      { role: "user", text: "</pre><script>alert(3)</script>" },
    ],
    filesTouched: ["src/<script>.ts"],
    warnings: ['<script>alert(4)</script> & more'],
  };

  it("escapes transcript text instead of emitting markup", () => {
    const html = renderHandoffHtml(renderHandoffMd(hostile, meta), meta);
    expect(tagsOf(html).some((tag) => /^<\s*(script|img)/i.test(tag))).toBe(false);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("&#39;single&#39;");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(3)&lt;/script&gt;");
    expect(html).toContain("src/&lt;script&gt;.ts");
    expect(html).toContain("&lt;script&gt;alert(4)&lt;/script&gt;");
  });

  it("escapes a hostile title", () => {
    const html = renderHandoffHtml("# x\n", { ...meta, title: '</title><script>alert(5)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</title><");
  });

  it("makes zero external requests", () => {
    const html = renderHandoffHtml(renderHandoffMd(hostile, meta), meta);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    // Assertions are on real tags only: escaped transcript text may well contain
    // the literal characters "src=" or "<img", and that is exactly the point.
    for (const tag of tagsOf(html)) {
      expect(tag).not.toMatch(/^<\s*(script|link|iframe|img|a)\b/i);
      expect(tag).not.toMatch(/\b(src|href|srcset|background|formaction)\s*=/i);
      expect(tag).not.toMatch(/\bon[a-z]+\s*=/i);
    }
  });

  it("is a self-contained document with inline css", () => {
    const html = renderHandoffHtml(renderHandoffMd(session, meta), meta);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<style>");
    expect(html).toContain("</html>");
    expect(html).toContain("<title>handoff: fix the budget guard</title>");
  });

  it("renders the known section structure as headings, lists and pre blocks", () => {
    const html = renderHandoffHtml(renderHandoffMd(session, meta), meta);
    for (const section of HANDOFF_SECTIONS) {
      expect(html).toContain(`<h2>${section}</h2>`);
    }
    expect(html).toContain("<h1>handoff: fix the budget guard</h1>");
    expect(html).toContain("<li>src/core/budget.ts</li>");
    expect(html).toContain("<pre>make the budget guard fail closed</pre>");
    expect(html).toContain('<p class="banner">');
  });

  it("does not interpret inline markdown, so a link cannot be smuggled in", () => {
    const md = renderHandoffMd(
      { ...session, turns: [{ role: "user", text: "[click](javascript:alert(1))" }] },
      meta,
    );
    const html = renderHandoffHtml(md, meta);
    expect(html).toContain("[click](javascript:alert(1))");
    expect(html).not.toMatch(/<a\b/i);
  });
});

describe("renderFilesTxt", () => {
  it("dedupes, sorts and ends with a newline", () => {
    const txt = renderFilesTxt({
      ...session,
      filesTouched: ["src/b.ts", "src/a.ts", "src/b.ts", " src/a.ts ", "src/c.ts"],
    });
    expect(txt).toBe("src/a.ts\nsrc/b.ts\nsrc/c.ts\n");
  });

  it("returns nothing for a session with no files", () => {
    expect(renderFilesTxt(emptySession)).toBe("");
  });
});
