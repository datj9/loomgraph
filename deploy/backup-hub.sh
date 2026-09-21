#!/usr/bin/env bash
#
# backup-hub.sh - WAL-safe, verified backup of the loomgraph hub database.
#
# hub.db runs PRAGMA journal_mode=WAL (src/hub/storage.ts), so it has -wal and
# -shm sidecars and a plain `cp hub.db` produces an INCONSISTENT snapshot:
# committed pages that still live only in the WAL are silently lost. This
# script uses `VACUUM INTO`, which takes a read transaction against the live
# database and writes a fully-checkpointed, self-contained copy.
#
# The store is also a hash chain - row_hash = sha256(prev_hash || json), with
# the head in chain_head (src/hub/storage.ts) - so a torn or partial copy can
# open cleanly and still be corrupt. Every copy is therefore verified before it
# is kept:
#   (a) the copy opens,
#   (b) PRAGMA integrity_check returns ok,
#   (c) the hash chain verifies end to end, from the 32-zero-byte genesis to
#       the value stored in chain_head.
# Any failure renames the copy to *.rejected and exits non-zero.
#
# This runs against a LIVE server, and storage.ts sets no busy_timeout on any
# connection, so a lock conflict surfaces immediately as SQLITE_BUSY. The
# snapshot therefore sets its own busy_timeout and retries with exponential
# backoff, and gives up with exit code 3 rather than emitting a partial copy.
#
# Every database access runs as the lghub service user: node:sqlite creates
# hub.db-wal / hub.db-shm on demand, and root-owned sidecars would lock the
# service out of its own store.
#
# Restore is a documented MANUAL procedure, deliberately not a flag here.
#
# Exit codes: 0 ok | 1 failure or failed verification | 2 usage | 3 could not
# acquire a lock (retryable; safe for cron to treat as "try again later").
#
# Usage: sudo ./backup-hub.sh
# Overrides (env): LGHUB_DATA_DIR, LGHUB_BACKUP_DIR, LGHUB_RETAIN, LGHUB_USER,
#                  LGHUB_BUSY_TIMEOUT_MS, LGHUB_BUSY_RETRIES

set -euo pipefail

readonly DATA_DIR="${LGHUB_DATA_DIR:-/var/lib/lghub}"
readonly BACKUP_DIR="${LGHUB_BACKUP_DIR:-/var/backups/lghub}"
readonly SERVICE_USER="${LGHUB_USER:-lghub}"
readonly RETAIN="${LGHUB_RETAIN:-14}"
readonly DB_PATH="${DATA_DIR}/hub.db"
# storage.ts sets no busy_timeout anywhere, so a lock conflict with the running
# server surfaces instantly as SQLITE_BUSY. This script runs against a live
# server by design, so it sets its own timeout and retries with backoff.
readonly BUSY_TIMEOUT_MS="${LGHUB_BUSY_TIMEOUT_MS:-10000}"
readonly BUSY_RETRIES="${LGHUB_BUSY_RETRIES:-5}"
# Exit codes: 0 ok, 1 failed/verification failed, 2 usage, 3 could not acquire
# a lock (retryable - safe for a cron job to treat as "try again later").
readonly EXIT_BUSY=3

log() { printf 'backup-hub: %s\n' "$*"; }
die() { printf 'backup-hub: FATAL %s\n' "$*" >&2; exit 1; }

WORK_DIR=""
VERIFIER_PATH=""
cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

# Run a command as the hub service user so any SQLite sidecar files touched
# during the read stay lghub-owned. Running the read as root can leave a
# root-owned -wal/-shm behind and lock the service out of its own database.
run_as_hub() {
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    die "must run as root or as ${SERVICE_USER} (current user: $(id -un))"
  fi
}

preflight() {
  local cmd
  for cmd in node find sort; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing required command: ${cmd}"
  done
  if [ "$(id -un)" != "$SERVICE_USER" ] && [ "$(id -u)" -ne 0 ]; then
    die "must run as root or as ${SERVICE_USER} (current user: $(id -un))"
  fi
  [ -f "$DB_PATH" ] || die "database not found: ${DB_PATH}"
  if ! [[ "$RETAIN" =~ ^[0-9]+$ ]] || [ "$RETAIN" -lt 1 ]; then
    die "LGHUB_RETAIN must be a positive integer, got: ${RETAIN}"
  fi
  if ! [[ "$BUSY_RETRIES" =~ ^[0-9]+$ ]] || [ "$BUSY_RETRIES" -lt 1 ]; then
    die "LGHUB_BUSY_RETRIES must be a positive integer, got: ${BUSY_RETRIES}"
  fi
  if ! [[ "$BUSY_TIMEOUT_MS" =~ ^[0-9]+$ ]]; then
    die "LGHUB_BUSY_TIMEOUT_MS must be a non-negative integer, got: ${BUSY_TIMEOUT_MS}"
  fi
  if [ ! -d "$BACKUP_DIR" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$BACKUP_DIR"
      log "created ${BACKUP_DIR} (0750 ${SERVICE_USER}:${SERVICE_USER})"
    else
      die "backup directory does not exist and cannot be created as a non-root user: ${BACKUP_DIR}"
    fi
  fi
}

# Sets WORK_DIR and VERIFIER_PATH. Must NOT be called in a command
# substitution: the subshell would discard WORK_DIR and leak the temp dir past
# the EXIT trap.
write_verifier() {
  WORK_DIR="$(mktemp -d)"
  # World-readable so the unprivileged service user can read the script when
  # this runs under runuser. It contains no secrets.
  chmod 0755 "$WORK_DIR"
  VERIFIER_PATH="${WORK_DIR}/vacuum-and-verify.mjs"
  cat >"$VERIFIER_PATH" <<'VERIFIER_EOF'
// VACUUM INTO a live WAL database, then verify the copy: it opens, passes
// PRAGMA integrity_check, and its hash chain is continuous end to end.
//
// Chain construction copied from src/hub/storage.ts:
//   genesis   = 32 zero bytes (chain_head seed)
//   row_hash  = sha256(prev_hash || json)   json is the client line, utf8, verbatim
//   chain_head.head = row_hash of the most recently inserted event
// Insertion order is rowid order: `events` is an ordinary rowid table and
// triggers forbid UPDATE and DELETE, so rowids are append-only.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";

const [srcPath, dstPath, busyTimeoutMsArg, retriesArg] = process.argv.slice(2);
if (!srcPath || !dstPath) {
  console.error("usage: vacuum-and-verify.mjs <source.db> <dest.db> [busyTimeoutMs] [retries]");
  process.exit(2);
}
const busyTimeoutMs = Number(busyTimeoutMsArg ?? 10000);
const maxAttempts = Number(retriesArg ?? 5);

function fail(message) {
  console.error(`backup-hub: VERIFY FAILED: ${message}`);
  process.exit(1);
}

function toBuffer(value, what) {
  if (value === null || value === undefined) fail(`${what} is NULL`);
  return Buffer.from(value);
}

/**
 * src/hub/storage.ts sets no busy_timeout on any connection, so a lock
 * conflict surfaces immediately as SQLITE_BUSY rather than waiting. This
 * script runs against a live server by design, so it must expect that and
 * retry rather than emit a partial or missing snapshot.
 *
 * Observed shape from node:sqlite: code ERR_SQLITE_ERROR, errcode 5,
 * errstr "database is locked". 261 = SQLITE_BUSY_SNAPSHOT, 517 =
 * SQLITE_BUSY_TIMEOUT.
 */
function isBusy(err) {
  const code = err?.errcode;
  if (code === 5 || code === 261 || code === 517) return true;
  return /database is locked|database table is locked/i.test(String(err?.message ?? ""));
}

/** Synchronous sleep: this script is deliberately straight-line. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 1. Snapshot. VACUUM INTO reads the live database under a read transaction
//    and writes a checkpointed, standalone copy - no -wal/-shm needed.
//    It either completes or throws; a throw leaves a partial file behind,
//    which is removed before the next attempt so no torn copy can survive.
let snapshotted = false;
for (let attempt = 1; attempt <= maxAttempts && !snapshotted; attempt += 1) {
  let src;
  try {
    src = new DatabaseSync(srcPath, { readOnly: true });
    src.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    src.exec(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);
    snapshotted = true;
  } catch (err) {
    rmSync(dstPath, { force: true });
    if (!isBusy(err)) {
      console.error(
        `backup-hub: VACUUM INTO failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    if (attempt === maxAttempts) {
      console.error(
        `backup-hub: BUSY: could not acquire a read lock on ${srcPath} after ${maxAttempts} ` +
          `attempt(s) with a ${busyTimeoutMs}ms busy_timeout each. No backup was produced. ` +
          `Something is holding a long write lock - check the hub server and any manual ` +
          `lg-hub command.`,
      );
      process.exit(3);
    }
    const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 16000);
    console.error(
      `backup-hub: SQLITE_BUSY on attempt ${attempt}/${maxAttempts}; retrying in ${backoffMs}ms`,
    );
    sleepSync(backoffMs);
  } finally {
    if (src !== undefined) src.close();
  }
}

// 2. The copy opens, and 3. integrity_check / chain continuity.
let dst;
try {
  dst = new DatabaseSync(dstPath, { readOnly: true });

  const integrity = dst.prepare("PRAGMA integrity_check").all();
  const verdict = integrity.map((r) => String(r.integrity_check)).join("; ");
  if (integrity.length !== 1 || verdict !== "ok") {
    fail(`PRAGMA integrity_check returned: ${verdict}`);
  }

  const genesis = Buffer.alloc(32);
  let expected = genesis;
  let count = 0;
  const rows = dst
    .prepare("SELECT rowid AS rid, json, prev_hash, row_hash FROM events ORDER BY rowid")
    .iterate();
  for (const row of rows) {
    const prev = toBuffer(row.prev_hash, `events.prev_hash at rowid ${row.rid}`);
    const stored = toBuffer(row.row_hash, `events.row_hash at rowid ${row.rid}`);
    if (!prev.equals(expected)) {
      fail(
        `chain break at rowid ${row.rid}: stored prev_hash ${prev.toString("hex")} ` +
          `!= previous row_hash ${expected.toString("hex")}`,
      );
    }
    const computed = createHash("sha256").update(expected).update(String(row.json), "utf8").digest();
    if (!computed.equals(stored)) {
      fail(
        `chain break at rowid ${row.rid}: stored row_hash ${stored.toString("hex")} ` +
          `!= sha256(prev_hash || json) ${computed.toString("hex")}`,
      );
    }
    expected = computed;
    count += 1;
  }

  const headRow = dst.prepare("SELECT head FROM chain_head WHERE id=1").get();
  if (headRow === undefined) fail("chain_head has no row with id=1");
  const head = toBuffer(headRow.head, "chain_head.head");
  if (!head.equals(expected)) {
    fail(
      `chain_head ${head.toString("hex")} does not match the last row hash ` +
        `${expected.toString("hex")} (${count} event(s) walked)`,
    );
  }

  console.log(
    `backup-hub: verified - integrity_check ok, ${count} event(s), chain head ${head.toString("hex")}`,
  );
} catch (err) {
  console.error(`backup-hub: verification error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  if (dst !== undefined) dst.close();
}
VERIFIER_EOF
  chmod 0644 "$VERIFIER_PATH"
}

prune() {
  local stale
  # Names are UTC timestamps, so lexical sort is chronological.
  stale="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'hub-*.db' -printf '%f\n' |
    sort -r | tail -n "+$((RETAIN + 1))" || true)"
  if [ -z "$stale" ]; then
    log "retention: ${RETAIN} copies kept, nothing to prune"
    return 0
  fi
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    rm -f -- "${BACKUP_DIR}/${name}"
    log "pruned ${name}"
  done <<<"$stale"
}

main() {
  preflight

  local stamp out
  write_verifier
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="${BACKUP_DIR}/hub-${stamp}.db"

  if [ -e "$out" ]; then
    die "backup target already exists: ${out}"
  fi

  log "snapshotting ${DB_PATH} -> ${out}"
  local rc=0
  run_as_hub node --disable-warning=ExperimentalWarning \
    "$VERIFIER_PATH" "$DB_PATH" "$out" "$BUSY_TIMEOUT_MS" "$BUSY_RETRIES" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq "$EXIT_BUSY" ]; then
      # The verifier already removed any partial file before giving up.
      printf 'backup-hub: FATAL could not acquire a lock on %s; NO backup was produced. Retry later.\n' \
        "$DB_PATH" >&2
      exit "$EXIT_BUSY"
    fi
    if [ -e "$out" ]; then
      mv -- "$out" "${out}.rejected"
      die "backup verification failed; copy kept for inspection at ${out}.rejected (it is NOT a usable backup)"
    fi
    die "backup failed before a copy was produced"
  fi

  chmod 0640 "$out"
  log "backup complete: ${out} ($(du -h -- "$out" | cut -f1))"
  prune
}

main "$@"
