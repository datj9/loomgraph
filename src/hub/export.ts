import type { HubStore } from "./storage.js";

/**
 * A stored run's raw lines, grouped by its identity. `member` and `runId` live
 * in the resulting path, never in an envelope around a line.
 */
export interface ExportGroup {
  member: string;
  runId: string;
  lines: string[];
}

/**
 * member/runId -> the raw stored lines, in seq order. Lines are never re-encoded.
 *
 * This is deliberately pure and filesystem-free so the byte-for-byte claim is
 * testable without spawning a CLI. `HubStore.allEvents()` already yields the
 * verbatim `json` column in `member, run_id, seq` order, so grouping here never
 * touches a line's contents.
 */
export function exportGroups(store: HubStore): ExportGroup[] {
  const groups = new Map<string, ExportGroup>();
  for (const ev of store.allEvents()) {
    const key = `${ev.member}\u0000${ev.runId}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { member: ev.member, runId: ev.runId, lines: [] };
      groups.set(key, group);
    }
    group.lines.push(ev.json);
  }
  return [...groups.values()];
}
