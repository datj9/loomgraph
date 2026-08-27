#!/usr/bin/env node
/*
 * Why this file exists separately from serve.ts: node:sqlite prints an
 * `ExperimentalWarning` to stderr on first import, and this filter must be
 * installed BEFORE the static import graph that pulls in node:sqlite is
 * evaluated. Because a static `import` is hoisted and evaluated before any
 * top-level statement, installing the filter in the same file that statically
 * imports storage.js would be too late and would silently do nothing. So this
 * file installs the filter first and then dynamically imports serve.js, which
 * is the file that statically imports node:sqlite and exports the entry
 * function. If you merge this back into one file, the warning silently
 * returns. Keep the split.
 */
void (async () => {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    const w = warning as { name?: string; message?: string };
    if (
      w.name === "ExperimentalWarning" &&
      (w.message ?? "").includes("SQLite is an experimental feature")
    ) {
      return;
    }
    console.error(warning);
  });
  const { main } = await import("./serve.js");
  await main();
})();
