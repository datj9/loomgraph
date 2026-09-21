#!/usr/bin/env bash
#
# netbird-acl.sh - converge NetBird access control to the loomgraph hub model:
# members reach the hub on one TCP port and nothing else, the operator keeps
# mesh SSH, and the default All -> All policy is disabled (never deleted).
#
# Default mode is DRY-RUN: nothing is written without an explicit --apply.
#
#   deploy/netbird-acl.sh              dry-run, print every API call it would make
#   deploy/netbird-acl.sh --apply      converge (idempotent, re-runnable)
#   deploy/netbird-acl.sh --verify     read-only check of the converged state
#
# The management API token is read from the macOS Keychain (or an `nbtoken`
# helper) and is never printed, logged, or passed on a command line.
#
set -euo pipefail

# ---------------------------------------------------------------- configuration

# This script ships with NO deployment addresses baked in. Yours live in
# deploy/hub.env (gitignored); copy deploy/hub.env.example and fill it in. A
# script that falls back to someone else's mesh IP converges the wrong network,
# so the REQUIRED variables abort instead of defaulting.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${LOOMGRAPH_HUB_ENV:-$SCRIPT_DIR/hub.env}"
if [ -f "$ENV_FILE" ]; then
  # `set -a` exports every assignment so the values reach this script's own
  # parameter expansions below and any child process that wants them.
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

# Named here rather than inlined at each use so the error says WHICH file to
# edit. `die` is defined further down; this runs after it, from main's preamble.
require_var() {
  local name="$1" value="$2" what="$3"
  if [ -z "$value" ]; then
    die "$name is not set ($what). Set it in $ENV_FILE - copy deploy/hub.env.example to start."
  fi
}

API_BASE="${NETBIRD_API:-}"
KEYCHAIN_SERVICE="${NETBIRD_KEYCHAIN_SERVICE:-netbird-pat}"

HUB_PEER_IP="${LOOMGRAPH_HUB_IP:-}"
HUB_PEER_NAME="${LOOMGRAPH_HUB_PEER_NAME:-the hub peer}"
SANDBOX_PEER_IP="${LOOMGRAPH_SANDBOX_IP:-}"
IFS=',' read -r -a MAC_PEER_IPS <<< "${LOOMGRAPH_MAC_IPS:-}"
HUB_PORT="${LOOMGRAPH_HUB_PORT:-8369}"
SSH_PORT="22"

# The hub serves its web UI for ANY non-/v1 GET, so a status-code probe on a
# path like /healthz returns 200 with an HTML page even when the API is dead.
# Probe the real route and assert on the BODY.
HEALTH_PATH="${LOOMGRAPH_HEALTH_PATH:-/v1/health}"
HEALTH_EXPECT="${LOOMGRAPH_HEALTH_EXPECT:-}"
PROBE_CONNECT_TIMEOUT="${LOOMGRAPH_PROBE_CONNECT_TIMEOUT:-5}"
PROBE_TIMEOUT="${LOOMGRAPH_PROBE_TIMEOUT:-10}"
# Ports a colleague peer must NOT reach on the personal MacBooks.
BLOCKED_PROBE_PORTS=(22 80 443 "$HUB_PORT")

GROUP_HUB="hub"
GROUP_MEMBERS="loomgraph-members"
GROUP_SANDBOX="sandbox"
GROUP_MACS="personal macbooks"
GROUP_CLIENTS="clients"
GROUP_ALL="All"

POLICY_MEMBER_HUB="loomgraph-hub-access"
POLICY_OP_HUB="loomgraph-operator-hub-access"
POLICY_OP_HUB_SSH="loomgraph-operator-hub-ssh"
POLICY_OP_SANDBOX_SSH="loomgraph-operator-sandbox-ssh"
POLICY_DEFAULT="Default"
# Optional one-off cleanup. Empty means "no stale policy to delete" and step 5
# becomes a no-op rather than matching a policy name that is not yours.
POLICY_DEAD="${NETBIRD_DEAD_POLICY:-}"

# A route to the hub that does NOT depend on the mesh, printed in the lockout
# warning. Empty is a legitimate answer - and one worth seeing spelled out
# before the All -> All policy goes away.
PUBLIC_FALLBACK_SSH="${LOOMGRAPH_HUB_PUBLIC_SSH:-}"
SANDBOX_SSH="${LOOMGRAPH_SANDBOX_SSH:-}"
HUB_SSH="${LOOMGRAPH_HUB_SSH:-}"

# ---------------------------------------------------------------- mode + output

MODE="dry-run"
ASSUME_YES="no"
FROM_MEMBER="no"
DO_PROBE="yes"
FAIL_COUNT=0
PASS_COUNT=0

usage() {
  cat <<'USAGE'
Usage: netbird-acl.sh [--apply | --verify | --dry-run] [options]

  (no flag)      DRY-RUN. Prints every API call that --apply would make. Default.
  --apply        Perform the changes. Requires the self-lockout guard to pass.
  --verify       Read-only. Checks the converged state against the acceptance
                 criteria, PASS/FAIL each. Exit 1 on any FAIL.

  --assume-yes   Skip the interactive confirmation before disabling "Default".
                 Required when --apply runs without a TTY.
  --from-member  Run --verify from a loomgraph-members peer: adds the negative
                 reachability probes (the MacBooks must be UNREACHABLE from here).
                 Meaningless from the operator Mac - it would prove nothing.
  --no-probe     --verify checks the API state only; skip all network probes.

Configuration:
  Read from deploy/hub.env (override the path with LOOMGRAPH_HUB_ENV), then
  from the environment. Copy deploy/hub.env.example and fill it in - nothing
  deployment-specific is baked into this script.

  NETBIRD_API                 REQUIRED. Management API base URL, incl. /api
  NETBIRD_TOKEN               API token (else `nbtoken`, else macOS Keychain)
  NETBIRD_KEYCHAIN_SERVICE    Keychain service name, default netbird-pat
  LOOMGRAPH_HUB_IP            REQUIRED. Hub peer mesh IP
  LOOMGRAPH_HUB_PEER_NAME     display name for that peer in output
  LOOMGRAPH_SANDBOX_IP        second operator-SSH peer; empty skips it
  LOOMGRAPH_MAC_IPS           REQUIRED for --from-member. Comma-separated mesh
                              IPs that a member peer must NOT reach
  LOOMGRAPH_HUB_PORT          hub service port, default 8369
  LOOMGRAPH_HEALTH_PATH       hub health route, default /v1/health
  LOOMGRAPH_HEALTH_EXPECT     regex the health body must match (overrides the
                              built-in healthy-body heuristic)
  LOOMGRAPH_HUB_PUBLIC_SSH    non-mesh fallback host:port for the lockout warning
  NETBIRD_DEAD_POLICY         exact name of a stale policy to delete; empty skips
USAGE
}

log()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'ERROR %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  FAIL  %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)       MODE="apply" ;;
    --verify)      MODE="verify" ;;
    --dry-run)     MODE="dry-run" ;;
    --assume-yes)  ASSUME_YES="yes" ;;
    --from-member) FROM_MEMBER="yes" ;;
    --no-probe)    DO_PROBE="no" ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------- prerequisites

for required in curl python3; do
  command -v "$required" >/dev/null 2>&1 || die "required command not found: $required"
done

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/netbird-acl.XXXXXX")"
chmod 700 "$WORKDIR"
cleanup() {
  case "$WORKDIR" in
    */netbird-acl.*) rm -r -f -- "$WORKDIR" ;;
  esac
}
trap cleanup EXIT INT TERM

GROUPS_JSON="$WORKDIR/groups.json"
POLICIES_JSON="$WORKDIR/policies.json"
PEERS_JSON="$WORKDIR/peers.json"
NBJSON="$WORKDIR/nbjson.py"

# ---------------------------------------------------------------- json helper
#
# A single read-only python helper. It never touches the network and never sees
# the token; it only parses the JSON curl already fetched and builds request
# bodies with correct escaping.

cat > "$NBJSON" <<'PY'
"""Read-only JSON helpers for netbird-acl.sh. No network, no secrets."""
import json
import re
import sys


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def group_by_name(groups, name):
    for group in groups:
        if group.get("name") == name:
            return group
    return None


def group_peer_ids(group):
    ids = []
    for peer in group.get("peers") or []:
        if isinstance(peer, dict):
            ids.append(peer.get("id", ""))
        else:
            ids.append(str(peer))
    return [i for i in ids if i]


def rule_group_ids(rule, key):
    ids = []
    for item in rule.get(key) or []:
        if isinstance(item, dict):
            ids.append(item.get("id", ""))
        else:
            ids.append(str(item))
    return [i for i in ids if i]


def policy_by_name(policies, name):
    found = [p for p in policies if p.get("name") == name]
    if len(found) > 1:
        sys.stderr.write("WARN  %d policies named %r; using the first\n" % (len(found), name))
    return found[0] if found else None


def cmd_group_id(argv):
    group = group_by_name(load(argv[0]), argv[1])
    if not group:
        return 1
    sys.stdout.write(group.get("id", ""))
    return 0


def cmd_group_peers(argv):
    group = group_by_name(load(argv[0]), argv[1])
    if not group:
        return 1
    for peer_id in group_peer_ids(group):
        print(peer_id)
    return 0


def cmd_group_peer_count(argv):
    group = group_by_name(load(argv[0]), argv[1])
    if not group:
        return 1
    print(len(group_peer_ids(group)))
    return 0


def cmd_peer_id(argv):
    for peer in load(argv[0]):
        if peer.get("ip") == argv[1]:
            sys.stdout.write(peer.get("id", ""))
            return 0
    return 1


def cmd_peer_name(argv):
    for peer in load(argv[0]):
        if peer.get("ip") == argv[1]:
            sys.stdout.write(peer.get("name", ""))
            return 0
    return 1


def cmd_peer_ip(argv):
    for peer in load(argv[0]):
        if peer.get("id") == argv[1]:
            sys.stdout.write(peer.get("ip", ""))
            return 0
    return 1


def cmd_groups_of_peer(argv):
    for group in load(argv[0]):
        if argv[1] in group_peer_ids(group):
            print(group.get("name", ""))
    return 0


def cmd_policy_id(argv):
    policy = policy_by_name(load(argv[0]), argv[1])
    if not policy:
        return 1
    sys.stdout.write(policy.get("id", ""))
    return 0


def cmd_policy_enabled(argv):
    policy = policy_by_name(load(argv[0]), argv[1])
    if not policy:
        return 1
    return 0 if policy.get("enabled") else 2


def cmd_policy_matches(argv):
    """policy-matches <policies.json> <name> <src-id> <dst-id> <proto> <ports-csv> <bidir>

    Exit 0 only when the named policy is enabled AND carries an enabled accept
    rule that is exactly src -> dst on that protocol/port set/direction.
    """
    path, name, src, dst, proto, ports_csv, bidir = argv[:7]
    policy = policy_by_name(load(path), name)
    if not policy or not policy.get("enabled"):
        return 1
    want_ports = sorted(p for p in ports_csv.split(",") if p)
    want_bidir = bidir.lower() == "true"
    for rule in policy.get("rules") or []:
        if not rule.get("enabled"):
            continue
        if rule.get("action", "accept") != "accept":
            continue
        if rule_group_ids(rule, "sources") != [src]:
            continue
        if rule_group_ids(rule, "destinations") != [dst]:
            continue
        if rule.get("protocol") != proto:
            continue
        if sorted(str(p) for p in (rule.get("ports") or [])) != want_ports:
            continue
        if rule.get("port_ranges"):
            continue
        if bool(rule.get("bidirectional")) != want_bidir:
            continue
        return 0
    return 1


def cmd_rules_referencing(argv):
    """rules-referencing <policies.json> <group-id>

    -> policy|rule|enabled|role|protocol|ports|direction, one line per rule.
    """
    path, group_id = argv[:2]
    for policy in load(path):
        for rule in policy.get("rules") or []:
            roles = []
            if group_id in rule_group_ids(rule, "sources"):
                roles.append("source")
            if group_id in rule_group_ids(rule, "destinations"):
                roles.append("destination")
            if not roles:
                continue
            enabled = bool(policy.get("enabled")) and bool(rule.get("enabled"))
            print("|".join([
                policy.get("name", ""),
                rule.get("name", ""),
                "enabled" if enabled else "disabled",
                "+".join(roles),
                str(rule.get("protocol", "")),
                ",".join(str(p) for p in (rule.get("ports") or [])),
                "bidirectional" if rule.get("bidirectional") else "unidirectional",
            ]))
    return 0


def cmd_dead_policy_safe(argv):
    """Exit 0 only when every rule of the named policy has no sources and no destinations."""
    policy = policy_by_name(load(argv[0]), argv[1])
    if not policy:
        return 1
    for rule in policy.get("rules") or []:
        if rule_group_ids(rule, "sources") or rule_group_ids(rule, "destinations"):
            return 2
    return 0


def cmd_mk_group(argv):
    print(json.dumps({"name": argv[0], "peers": [p for p in argv[1:] if p]}, sort_keys=True))
    return 0


def cmd_mk_policy(argv):
    """mk-policy <name> <description> <src-id> <dst-id> <proto> <ports-csv> <bidir>"""
    name, description, src, dst, proto, ports_csv, bidir = argv[:7]
    rule = {
        "name": name,
        "description": description,
        "enabled": True,
        "action": "accept",
        "bidirectional": bidir.lower() == "true",
        "protocol": proto,
        "sources": [src],
        "destinations": [dst],
    }
    ports = [p for p in ports_csv.split(",") if p]
    if ports:
        rule["ports"] = ports
    print(json.dumps({
        "name": name,
        "description": description,
        "enabled": True,
        "sourcePostureChecks": [],
        "rules": [rule],
    }, sort_keys=True))
    return 0


def cmd_mk_disable(argv):
    """Build the PUT body that disables a policy, preserving every rule verbatim.

    GET returns sources/destinations as expanded group objects; PUT wants bare
    group ids. Only the top-level `enabled` flag changes - same as the toggle in
    the dashboard, so the policy can be re-enabled with one more PUT.
    """
    policy = policy_by_name(load(argv[0]), argv[1])
    if not policy:
        return 1
    rules = []
    for rule in policy.get("rules") or []:
        new_rule = {
            "id": rule.get("id"),
            "name": rule.get("name", ""),
            "description": rule.get("description", ""),
            "enabled": bool(rule.get("enabled")),
            "action": rule.get("action", "accept"),
            "bidirectional": bool(rule.get("bidirectional")),
            "protocol": rule.get("protocol", "all"),
            "sources": rule_group_ids(rule, "sources"),
            "destinations": rule_group_ids(rule, "destinations"),
        }
        if rule.get("ports"):
            new_rule["ports"] = [str(p) for p in rule["ports"]]
        if rule.get("port_ranges"):
            new_rule["port_ranges"] = rule["port_ranges"]
        rules.append({k: v for k, v in new_rule.items() if v is not None})
    print(json.dumps({
        "name": policy.get("name", ""),
        "description": policy.get("description", ""),
        "enabled": False,
        "sourcePostureChecks": policy.get("source_posture_checks") or [],
        "rules": rules,
    }, sort_keys=True))
    return 0


HEALTHY_TOKENS = {"ok", "up", "true", "pass", "passing", "healthy", "serving", "alive", "ready"}


def cmd_health_verdict(argv):
    """health-verdict <body-file> [expect-regex] -> VERDICT:detail on stdout.

    The hub serves its web UI for any non-/v1 GET, so an HTML body means the API
    did not answer even when the status code was 200. Judge the body, never the
    status code alone.
    """
    with open(argv[0], "rb") as handle:
        raw = handle.read()
    text = raw.decode("utf-8", "replace").strip()
    expect = argv[1] if len(argv) > 1 else ""
    summary = " ".join(text.split())[:200]

    if not text:
        print("EMPTY:no response body")
        return 0
    lowered = text.lower()
    if lowered.startswith("<!doctype") or lowered.startswith("<html") or "<html" in lowered[:400]:
        print("HTML:the web UI answered, not the API - wrong route or the API is down: " + summary[:120])
        return 0
    if expect:
        if re.search(expect, text):
            print("HEALTHY:body matches the expected pattern: " + summary)
        else:
            print("EXPECT_MISMATCH:body does not match %r: %s" % (expect, summary))
        return 0

    def token_state(value):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in HEALTHY_TOKENS
        return None

    try:
        parsed = json.loads(text)
    except ValueError:
        if lowered in HEALTHY_TOKENS:
            print("HEALTHY:plain-text health token: " + summary)
        else:
            print("UNRECOGNIZED:body is neither JSON nor a known health token: " + summary)
        return 0

    if isinstance(parsed, dict):
        for key in ("status", "health", "state", "ok", "healthy", "result"):
            if key in parsed:
                state = token_state(parsed[key])
                if state is True:
                    print("HEALTHY:%s=%r in %s" % (key, parsed[key], summary))
                elif state is False:
                    print("UNHEALTHY:%s=%r in %s" % (key, parsed[key], summary))
                else:
                    print("JSON_NO_STATUS:%s is not a health token: %s" % (key, summary))
                return 0
        print("JSON_NO_STATUS:JSON body with no recognised status field: " + summary)
        return 0

    state = token_state(parsed)
    if state is True:
        print("HEALTHY:scalar health token: " + summary)
    elif state is False:
        print("UNHEALTHY:scalar health token: " + summary)
    else:
        print("JSON_NO_STATUS:scalar JSON body: " + summary)
    return 0


def cmd_id_of(argv):
    """Read the id out of a single API response object."""
    data = load(argv[0])
    sys.stdout.write(str(data.get("id", "")))
    return 0


def cmd_compact(argv):
    sys.stdout.write(json.dumps(load(argv[0]), sort_keys=True))
    return 0


COMMANDS = {
    "group-id": cmd_group_id,
    "group-peers": cmd_group_peers,
    "group-peer-count": cmd_group_peer_count,
    "peer-id": cmd_peer_id,
    "peer-name": cmd_peer_name,
    "peer-ip": cmd_peer_ip,
    "groups-of-peer": cmd_groups_of_peer,
    "policy-id": cmd_policy_id,
    "policy-enabled": cmd_policy_enabled,
    "policy-matches": cmd_policy_matches,
    "rules-referencing": cmd_rules_referencing,
    "dead-policy-safe": cmd_dead_policy_safe,
    "health-verdict": cmd_health_verdict,
    "mk-group": cmd_mk_group,
    "mk-policy": cmd_mk_policy,
    "mk-disable": cmd_mk_disable,
    "id-of": cmd_id_of,
    "compact": cmd_compact,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write("usage: nbjson.py <command> [args...]\n")
        sys.exit(64)
    sys.exit(COMMANDS[sys.argv[1]](sys.argv[2:]))
PY

nbj() { python3 "$NBJSON" "$@"; }

# ---------------------------------------------------------------- api plumbing

TOKEN=""
API_STATUS=""
API_BODY=""

load_token() {
  if [ -n "${NETBIRD_TOKEN:-}" ]; then
    TOKEN="$NETBIRD_TOKEN"
  elif command -v nbtoken >/dev/null 2>&1; then
    TOKEN="$(nbtoken)" || die "the nbtoken helper failed; check it or set NETBIRD_TOKEN"
  elif command -v security >/dev/null 2>&1; then
    TOKEN="$(security find-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" ||
      die "no Keychain item for service \"$KEYCHAIN_SERVICE\" / account \"$USER\"; add it or set NETBIRD_TOKEN"
  else
    die "no token source: set NETBIRD_TOKEN, install nbtoken, or store the PAT in the Keychain"
  fi
  [ -n "$TOKEN" ] || die "empty NetBird token from the configured source"
}

# api_call <method> <path> [body-file] -> response body on stdout, status in API_STATUS.
#
# The token reaches curl through a config file on stdin, so it never appears in
# the process table, in `ps`, or in any shell history.
api_call() {
  local method="$1" path="$2" body_file="${3:-}"
  local out status rc
  out="$WORKDIR/response.json"
  set +e
  status="$(
    {
      printf 'url = "%s%s"\n' "$API_BASE" "$path"
      printf 'request = "%s"\n' "$method"
      printf 'header = "Authorization: Token %s"\n' "$TOKEN"
      printf 'header = "Accept: application/json"\n'
      printf 'silent\n'
      printf 'show-error\n'
      printf 'output = "%s"\n' "$out"
      printf 'write-out = "%%{http_code}"\n'
      if [ -n "$body_file" ]; then
        printf 'header = "Content-Type: application/json"\n'
        printf 'data-binary = "@%s"\n' "$body_file"
      fi
    } | curl --config -
  )"
  rc="$?"
  set -e
  [ "$rc" -eq 0 ] || die "curl failed (exit $rc) on $method $path"
  API_STATUS="$status"
  if [ -f "$out" ]; then
    cat "$out"
    rm -f -- "$out"
  fi
}

api_get() {
  local path="$1" dest="$2"
  api_call GET "$path" > "$dest"
  case "$API_STATUS" in
    2*) ;;
    *) die "GET $path returned HTTP $API_STATUS: $(head -c 400 "$dest")" ;;
  esac
}

# api_write <method> <path> <body-file|""> <description>
#
# Dry-run: prints the exact call and body, changes nothing.
# Apply:   performs the call and leaves the response body in API_BODY.
api_write() {
  local method="$1" path="$2" body_file="$3" description="$4"
  API_BODY=""
  if [ "$MODE" != "apply" ]; then
    printf '  DRY-RUN %s %s%s\n' "$method" "$API_BASE" "$path"
    printf '          %s\n' "$description"
    if [ -n "$body_file" ]; then
      printf '          body: %s\n' "$(nbj compact "$body_file")"
    fi
    return 0
  fi
  API_BODY="$(api_call "$method" "$path" "$body_file")"
  case "$API_STATUS" in
    2*) info "$method $path -> HTTP $API_STATUS ($description)" ;;
    *)  die "$method $path returned HTTP $API_STATUS: $(printf '%s' "$API_BODY" | head -c 400)" ;;
  esac
}

refresh_state() {
  api_get "/groups" "$GROUPS_JSON"
  api_get "/policies" "$POLICIES_JSON"
  api_get "/peers" "$PEERS_JSON"
}

# ---------------------------------------------------------------- lookups

peer_id_for_ip() {
  local ip="$1" id
  if ! id="$(nbj peer-id "$PEERS_JSON" "$ip")"; then
    die "no NetBird peer found with mesh IP $ip"
  fi
  printf '%s' "$id"
}

group_id_or_empty() {
  local name="$1" id
  if id="$(nbj group-id "$GROUPS_JSON" "$name")"; then
    printf '%s' "$id"
  fi
}

require_group_id() {
  local name="$1" id
  id="$(group_id_or_empty "$name")"
  [ -n "$id" ] || die "expected group \"$name\" to exist but it does not"
  printf '%s' "$id"
}

slug() { printf '%s' "$1" | tr -c 'a-zA-Z0-9' '-'; }

# write_body <slug> <command...> -> path of the file holding the generated JSON
write_body() {
  local name="$1"
  shift
  local path="$WORKDIR/body-$name.json"
  "$@" > "$path"
  printf '%s' "$path"
}

# ---------------------------------------------------------------- convergence

# ensure_group <name> [peer-id...]  -> id in ENSURE_GROUP_ID
ENSURE_GROUP_ID=""
ensure_group() {
  local name="$1"
  shift
  local existing body
  existing="$(group_id_or_empty "$name")"
  if [ -n "$existing" ]; then
    info "group \"$name\" already exists ($existing) - no change"
    ENSURE_GROUP_ID="$existing"
    return 0
  fi
  body="$(write_body "group-$(slug "$name")" nbj mk-group "$name" "$@")"
  api_write POST "/groups" "$body" "create group \"$name\""
  if [ "$MODE" != "apply" ]; then
    ENSURE_GROUP_ID="<id-of-group-$name>"
    return 0
  fi
  printf '%s' "$API_BODY" > "$WORKDIR/created-group.json"
  ENSURE_GROUP_ID="$(nbj id-of "$WORKDIR/created-group.json")"
  [ -n "$ENSURE_GROUP_ID" ] || die "group \"$name\" was created but the API returned no id"
  info "group \"$name\" created ($ENSURE_GROUP_ID)"
}

# ensure_policy <name> <description> <src-id> <dst-id> <proto> <ports-csv> <bidir>
ensure_policy() {
  local name="$1" description="$2" src="$3" dst="$4" proto="$5" ports="$6" bidir="$7"
  local direction="unidirectional"
  [ "$bidir" = "false" ] || direction="bidirectional"
  if nbj policy-matches "$POLICIES_JSON" "$name" "$src" "$dst" "$proto" "$ports" "$bidir"; then
    info "policy \"$name\" already matches and is enabled - no change"
    return 0
  fi
  if nbj policy-id "$POLICIES_JSON" "$name" > /dev/null; then
    warn "policy \"$name\" exists but does not match the target rule."
    die "refusing to rewrite \"$name\" automatically - inspect it in the dashboard, fix or delete it, then re-run"
  fi
  local body
  body="$(write_body "policy-$(slug "$name")" \
    nbj mk-policy "$name" "$description" "$src" "$dst" "$proto" "$ports" "$bidir")"
  api_write POST "/policies" "$body" "create policy \"$name\" ($proto/$ports, $direction)"
}

# ---------------------------------------------------------------- lockout guard

# Evaluated against the live policy list. Every path the operator needs after
# "Default" goes away must already exist and be enabled.
operator_path_ok() {
  local macs="$1" hub="$2" sandbox="$3" ok=0
  if ! nbj policy-matches "$POLICIES_JSON" "$POLICY_OP_HUB" "$macs" "$hub" tcp "$HUB_PORT" false; then
    warn "missing or disabled: \"$POLICY_OP_HUB\" ($GROUP_MACS -> $GROUP_HUB tcp/$HUB_PORT)"
    ok=1
  fi
  if ! nbj policy-matches "$POLICIES_JSON" "$POLICY_OP_HUB_SSH" "$macs" "$hub" tcp "$SSH_PORT" false; then
    warn "missing or disabled: \"$POLICY_OP_HUB_SSH\" ($GROUP_MACS -> $GROUP_HUB tcp/$SSH_PORT)"
    ok=1
  fi
  if ! nbj policy-matches "$POLICIES_JSON" "$POLICY_OP_SANDBOX_SSH" "$macs" "$sandbox" tcp "$SSH_PORT" false; then
    warn "missing or disabled: \"$POLICY_OP_SANDBOX_SSH\" ($GROUP_MACS -> $GROUP_SANDBOX tcp/$SSH_PORT)"
    ok=1
  fi
  return "$ok"
}

lockout_warning() {
  printf '\n'
  printf '  ************************************************************\n'
  printf '  *  ABOUT TO DISABLE THE "Default" All -> All POLICY\n'
  printf '  *\n'
  printf '  *  If the new policies are insufficient you WILL lose mesh\n'
  printf '  *  access to %s. Fallbacks, in order:\n' "$HUB_PEER_NAME"
  printf '  *\n'
  if [ -n "$PUBLIC_FALLBACK_SSH" ]; then
    printf '  *    1. public SSH to %s, off the mesh\n' "$PUBLIC_FALLBACK_SSH"
  else
    printf '  *    1. NONE CONFIGURED - LOOMGRAPH_HUB_PUBLIC_SSH is empty, so\n'
    printf '  *       this script knows of no way back in without the mesh.\n'
  fi
  printf '  *    2. your provider console - know the login BEFORE continuing\n'
  printf '  *\n'
  printf '  *  Run this from a shell that does NOT depend on the mesh.\n'
  printf '  *  "Default" is disabled, never deleted: re-enable it with a\n'
  printf '  *  single PUT if anything goes wrong.\n'
  printf '  ************************************************************\n'
  printf '\n'
}

confirm_disable() {
  if [ "$ASSUME_YES" = "yes" ]; then
    info "confirmation skipped (--assume-yes)"
    return 0
  fi
  if [ ! -t 0 ]; then
    die "refusing to disable \"$POLICY_DEFAULT\" without a TTY; re-run with --assume-yes if you are sure"
  fi
  local answer=""
  printf 'Type DISABLE to continue, anything else aborts: '
  read -r answer
  [ "$answer" = "DISABLE" ] || die "aborted by operator; nothing was disabled"
}

# ---------------------------------------------------------------- converge flow

# Refuse to proceed if a colleague peer also sits in "clients" (which carries
# the 0.0.0.0/0 exit node) or in "personal macbooks". Membership is fixed by
# hand, not silently rewritten here.
check_member_membership() {
  local member_peer groups_of leaked=0
  if ! nbj group-id "$GROUPS_JSON" "$GROUP_MEMBERS" > /dev/null; then
    return 0
  fi
  while IFS= read -r member_peer; do
    [ -n "$member_peer" ] || continue
    groups_of="$(nbj groups-of-peer "$GROUPS_JSON" "$member_peer" | tr '\n' ' ')"
    case " $groups_of " in
      *" $GROUP_CLIENTS "*|*" $GROUP_MACS "*)
        warn "peer $member_peer is in \"$GROUP_MEMBERS\" and also in: $groups_of"
        leaked=1
        ;;
    esac
  done < <(nbj group-peers "$GROUPS_JSON" "$GROUP_MEMBERS")
  [ "$leaked" -eq 0 ] ||
    die "a $GROUP_MEMBERS peer also belongs to $GROUP_CLIENTS or $GROUP_MACS; fix group membership first"
}

converge() {
  local hub_peer sandbox_peer
  local hub_group members_group sandbox_group macs_group

  hub_peer="$(peer_id_for_ip "$HUB_PEER_IP")"
  # The sandbox peer is OPTIONAL. Spec 00 listed only `hub` and
  # `loomgraph-members`; the sandbox group exists because "operator retains mesh
  # SSH to a second box" is unsatisfiable without a destination group holding
  # it. A deployment with no such box sets LOOMGRAPH_SANDBOX_IP empty and gets
  # neither the group nor its policy - not an empty group that matches nothing.
  sandbox_peer=""
  if [ -n "$SANDBOX_PEER_IP" ]; then
    sandbox_peer="$(peer_id_for_ip "$SANDBOX_PEER_IP")"
  fi

  step "Step 1 - groups"
  ensure_group "$GROUP_HUB" "$hub_peer";        hub_group="$ENSURE_GROUP_ID"
  ensure_group "$GROUP_MEMBERS";                members_group="$ENSURE_GROUP_ID"
  sandbox_group=""
  if [ -n "$sandbox_peer" ]; then
    ensure_group "$GROUP_SANDBOX" "$sandbox_peer"; sandbox_group="$ENSURE_GROUP_ID"
  else
    info "LOOMGRAPH_SANDBOX_IP is empty - skipping the \"$GROUP_SANDBOX\" group"
  fi
  macs_group="$(require_group_id "$GROUP_MACS")"
  check_member_membership

  step "Step 2 - member policy ($GROUP_MEMBERS -> $GROUP_HUB tcp/$HUB_PORT, unidirectional)"
  ensure_policy "$POLICY_MEMBER_HUB" \
    "loomgraph colleagues reach the hub on tcp/$HUB_PORT and nothing else" \
    "$members_group" "$hub_group" tcp "$HUB_PORT" false

  step "Step 3 - operator policies (enumerated BEFORE Default is touched)"
  ensure_policy "$POLICY_OP_HUB" \
    "operator Macs reach the loomgraph hub port" \
    "$macs_group" "$hub_group" tcp "$HUB_PORT" false
  ensure_policy "$POLICY_OP_HUB_SSH" \
    "operator Macs administer the hub over the mesh" \
    "$macs_group" "$hub_group" tcp "$SSH_PORT" false
  if [ -n "$sandbox_group" ]; then
    ensure_policy "$POLICY_OP_SANDBOX_SSH" \
      "operator Macs keep mesh SSH to the sandbox peer" \
      "$macs_group" "$sandbox_group" tcp "$SSH_PORT" false
  else
    info "no sandbox peer configured - skipping \"$POLICY_OP_SANDBOX_SSH\""
  fi

  step "Step 4 - self-lockout guard, then DISABLE \"$POLICY_DEFAULT\""
  if [ "$MODE" = "apply" ]; then
    # Re-read live state: the guard must judge what the API actually has, not
    # what this run intended to create.
    refresh_state
    hub_group="$(require_group_id "$GROUP_HUB")"
    sandbox_group="$(require_group_id "$GROUP_SANDBOX")"
    macs_group="$(require_group_id "$GROUP_MACS")"
    if ! operator_path_ok "$macs_group" "$hub_group" "$sandbox_group"; then
      die "self-lockout guard FAILED: operator access policies are not in place. \"$POLICY_DEFAULT\" left ENABLED."
    fi
    info "self-lockout guard passed: operator keeps hub tcp/$HUB_PORT, hub tcp/$SSH_PORT, sandbox tcp/$SSH_PORT"
  else
    info "in --apply the guard re-reads live state here and refuses to disable"
    info "\"$POLICY_DEFAULT\" unless the three operator policies above exist and are enabled."
  fi

  local default_id=""
  if default_id="$(nbj policy-id "$POLICIES_JSON" "$POLICY_DEFAULT")"; then
    if nbj policy-enabled "$POLICIES_JSON" "$POLICY_DEFAULT"; then
      lockout_warning
      if [ "$MODE" = "apply" ]; then
        confirm_disable
      fi
      local body
      body="$(write_body "disable-default" nbj mk-disable "$POLICIES_JSON" "$POLICY_DEFAULT")"
      api_write PUT "/policies/$default_id" "$body" \
        "DISABLE (never delete) policy \"$POLICY_DEFAULT\""
      info "rollback: PUT /policies/$default_id with the same body and enabled=true"
    else
      info "\"$POLICY_DEFAULT\" is already disabled - no change"
    fi
  else
    warn "policy \"$POLICY_DEFAULT\" not found - it should exist, disabled, as a one-call rollback"
  fi

  step "Step 5 - delete the stale auto-created policy, if one was named"
  local dead_id=""
  if [ -z "$POLICY_DEAD" ]; then
    info "NETBIRD_DEAD_POLICY is empty - nothing to delete, skipping"
  elif dead_id="$(nbj policy-id "$POLICIES_JSON" "$POLICY_DEAD")"; then
    if nbj dead-policy-safe "$POLICIES_JSON" "$POLICY_DEAD"; then
      api_write DELETE "/policies/$dead_id" "" "delete dead policy \"$POLICY_DEAD\""
    else
      warn "\"$POLICY_DEAD\" has non-empty sources or destinations - NOT deleting it"
    fi
  else
    info "dead policy \"$POLICY_DEAD\" not present - no change"
  fi
  info "the PEER behind that policy is left alone; delete it by hand if it is not in use"

  if [ "$MODE" = "apply" ]; then
    printf '\nApply complete. Re-run with --verify to check the acceptance criteria.\n'
  else
    printf '\nDRY-RUN complete. Nothing was changed. Re-run with --apply to converge.\n'
  fi
}

# ---------------------------------------------------------------- verify flow

# ---------------------------------------------------------------- probes
#
# Network probes, not NetBird API calls. They never carry the token.
#
# PROBE_RC   curl exit code: 0 = an HTTP response came back, 7 = could not
#            connect, 28 = timed out, 52/56 = TCP connected then died.
# PROBE_CODE HTTP status (0 when no response).
# PROBE_BODY first 2 KiB of the body.
PROBE_RC=0
PROBE_CODE=""
PROBE_BODY_FILE=""

http_probe() {
  local host="$1" port="$2" path="$3"
  PROBE_BODY_FILE="$WORKDIR/probe-body"
  : > "$PROBE_BODY_FILE"
  set +e
  PROBE_CODE="$(
    curl --silent \
         --connect-timeout "$PROBE_CONNECT_TIMEOUT" \
         --max-time "$PROBE_TIMEOUT" \
         --output "$PROBE_BODY_FILE" \
         --write-out '%{http_code}' \
         "http://$host:$port$path" 2>/dev/null
  )"
  PROBE_RC="$?"
  set -e
}

# A peer that should be blocked must give us no HTTP response at all. curl exit
# 7 (refused/unreachable) or 28 (timeout, the usual NetBird drop) is the pass
# signal; anything that completed a TCP handshake is a FAIL.
probe_is_blocked() {
  case "$PROBE_RC" in
    7|28) return 0 ;;
    *)    return 1 ;;
  esac
}

probe_outcome_text() {
  case "$PROBE_RC" in
    0)  printf 'HTTP %s received' "$PROBE_CODE" ;;
    7)  printf 'connection refused or filtered (curl 7)' ;;
    28) printf 'timed out (curl 28) - consistent with an ACL drop' ;;
    52) printf 'TCP CONNECTED then empty reply (curl 52)' ;;
    56) printf 'TCP CONNECTED then reset (curl 56)' ;;
    35) printf 'TCP CONNECTED, TLS handshake attempted (curl 35)' ;;
    *)  printf 'curl exit %s' "$PROBE_RC" ;;
  esac
}

# Positive probe: the hub API itself must answer on the real route, and the
# BODY must look healthy. A 200 with an HTML page is the web UI answering for a
# non-/v1 path - that is a dead API, not a pass.
verify_hub_health() {
  local verdict kind detail
  http_probe "$HUB_PEER_IP" "$HUB_PORT" "$HEALTH_PATH"
  if [ "$PROBE_RC" -ne 0 ]; then
    fail "hub $HUB_PEER_IP:$HUB_PORT$HEALTH_PATH did not answer: $(probe_outcome_text)"
    return 0
  fi
  verdict="$(nbj health-verdict "$PROBE_BODY_FILE" "$HEALTH_EXPECT")"
  kind="${verdict%%:*}"
  detail="${verdict#*:}"
  case "$kind" in
    HEALTHY)
      pass "hub $HEALTH_PATH answered HTTP $PROBE_CODE and the body is healthy: $detail"
      ;;
    JSON_NO_STATUS)
      # A JSON body proves the API answered, not the UI - but the schema is not
      # one we recognise, so surface it instead of silently passing it as healthy.
      pass "hub $HEALTH_PATH answered HTTP $PROBE_CODE with a non-HTML JSON body ($detail)"
      info "check that body by eye, or pin it with LOOMGRAPH_HEALTH_EXPECT=<regex>"
      ;;
    HTML)
      fail "hub $HEALTH_PATH returned HTTP $PROBE_CODE but the body is the WEB UI, not the API: $detail"
      ;;
    *)
      fail "hub $HEALTH_PATH returned HTTP $PROBE_CODE with an unhealthy body [$kind]: $detail"
      ;;
  esac
}

# Negative probes. Only meaningful when run FROM a loomgraph-members peer.
verify_member_isolation() {
  local mac port blocked_all=0

  http_probe "$HUB_PEER_IP" "$HUB_PORT" "$HEALTH_PATH"
  if [ "$PROBE_RC" -eq 0 ]; then
    pass "member peer reaches the hub on $HUB_PEER_IP:$HUB_PORT (HTTP $PROBE_CODE)"
  else
    fail "member peer cannot reach the hub on $HUB_PEER_IP:$HUB_PORT: $(probe_outcome_text)"
  fi

  # Same host, a port the policy does not open: must be blocked.
  http_probe "$HUB_PEER_IP" "$SSH_PORT" "/"
  if probe_is_blocked; then
    pass "member peer is blocked from $HUB_PEER_IP:$SSH_PORT ($(probe_outcome_text))"
  else
    fail "member peer REACHED $HUB_PEER_IP:$SSH_PORT - the policy is wider than tcp/$HUB_PORT ($(probe_outcome_text))"
  fi

  for mac in "${MAC_PEER_IPS[@]}"; do
    for port in "${BLOCKED_PROBE_PORTS[@]}"; do
      http_probe "$mac" "$port" "/"
      if probe_is_blocked; then
        info "blocked as expected: $mac:$port ($(probe_outcome_text))"
      else
        fail "member peer REACHED MacBook $mac:$port - $(probe_outcome_text)"
        blocked_all=1
      fi
    done
  done
  if [ "$blocked_all" -eq 0 ]; then
    pass "member peer cannot reach either MacBook on ports ${BLOCKED_PROBE_PORTS[*]}"
  fi
}

verify_members_reach_only_hub() {
  local members_group="$1" extra=0 line policy_name enabled_flag
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    policy_name="${line%%|*}"
    enabled_flag="$(printf '%s' "$line" | cut -d'|' -f3)"
    if [ "$enabled_flag" != "enabled" ]; then
      continue
    fi
    if [ "$policy_name" = "$POLICY_MEMBER_HUB" ]; then
      continue
    fi
    fail "extra enabled rule touches $GROUP_MEMBERS: $line"
    extra=1
  done < <(nbj rules-referencing "$POLICIES_JSON" "$members_group")
  if [ "$extra" -eq 0 ]; then
    pass "no other enabled rule references $GROUP_MEMBERS"
  fi
}

verify_members_group_hygiene() {
  local stray=0 member_peer member_ip groups_of gname
  while IFS= read -r member_peer; do
    [ -n "$member_peer" ] || continue
    member_ip="$(nbj peer-ip "$PEERS_JSON" "$member_peer" || printf 'unknown-ip')"
    groups_of="$(nbj groups-of-peer "$GROUPS_JSON" "$member_peer")"
    while IFS= read -r gname; do
      [ -n "$gname" ] || continue
      case "$gname" in
        "$GROUP_ALL"|"$GROUP_MEMBERS") ;;
        *)
          fail "member peer $member_ip is also in group \"$gname\" (leak path around the ACL)"
          stray=1
          ;;
      esac
    done <<< "$groups_of"
  done < <(nbj group-peers "$GROUPS_JSON" "$GROUP_MEMBERS")
  if [ "$stray" -eq 0 ]; then
    pass "every $GROUP_MEMBERS peer sits only in $GROUP_ALL and $GROUP_MEMBERS"
  fi
}

verify() {
  local hub_peer sandbox_peer
  local hub_group members_group sandbox_group macs_group

  hub_peer="$(peer_id_for_ip "$HUB_PEER_IP")"
  sandbox_peer=""
  if [ -n "$SANDBOX_PEER_IP" ]; then
    sandbox_peer="$(peer_id_for_ip "$SANDBOX_PEER_IP")"
  fi

  step "Acceptance criteria"

  hub_group="$(group_id_or_empty "$GROUP_HUB")"
  if [ -z "$hub_group" ]; then
    fail "group \"$GROUP_HUB\" exists"
  else
    local hub_peers hub_count
    hub_peers="$(nbj group-peers "$GROUPS_JSON" "$GROUP_HUB" | tr '\n' ' ')"
    hub_count="$(nbj group-peer-count "$GROUPS_JSON" "$GROUP_HUB")"
    if [ "$hub_count" = "1" ] && [ "$hub_peers" = "$hub_peer " ]; then
      pass "group \"$GROUP_HUB\" holds exactly $HUB_PEER_NAME ($HUB_PEER_IP)"
    else
      fail "group \"$GROUP_HUB\" should hold only $HUB_PEER_NAME ($HUB_PEER_IP); holds $hub_count peer(s)"
    fi
  fi

  members_group="$(group_id_or_empty "$GROUP_MEMBERS")"
  if [ -z "$members_group" ]; then
    fail "group \"$GROUP_MEMBERS\" exists"
  else
    pass "group \"$GROUP_MEMBERS\" exists"
  fi

  sandbox_group=""
  if [ -z "$SANDBOX_PEER_IP" ]; then
    info "LOOMGRAPH_SANDBOX_IP is empty - sandbox criteria not checked"
  else
    sandbox_group="$(group_id_or_empty "$GROUP_SANDBOX")"
    if [ -z "$sandbox_group" ]; then
      fail "group \"$GROUP_SANDBOX\" exists (required for operator mesh SSH to $SANDBOX_PEER_IP)"
    else
      local sandbox_peers
      sandbox_peers="$(nbj group-peers "$GROUPS_JSON" "$GROUP_SANDBOX" | tr '\n' ' ')"
      if [ "$sandbox_peers" = "$sandbox_peer " ]; then
        pass "group \"$GROUP_SANDBOX\" holds exactly the sandbox peer ($SANDBOX_PEER_IP)"
      else
        fail "group \"$GROUP_SANDBOX\" should hold only the sandbox peer ($SANDBOX_PEER_IP)"
      fi
    fi
  fi

  macs_group="$(group_id_or_empty "$GROUP_MACS")"
  if [ -z "$macs_group" ]; then
    fail "group \"$GROUP_MACS\" exists"
  fi

  # A loomgraph-members peer reaches the hub IP on the hub port, and nothing else.
  if [ -n "$members_group" ] && [ -n "$hub_group" ] &&
     nbj policy-matches "$POLICIES_JSON" "$POLICY_MEMBER_HUB" \
       "$members_group" "$hub_group" tcp "$HUB_PORT" false; then
    pass "\"$POLICY_MEMBER_HUB\" enabled: $GROUP_MEMBERS -> $GROUP_HUB tcp/$HUB_PORT, unidirectional"
  else
    fail "\"$POLICY_MEMBER_HUB\" missing, disabled, or not exactly $GROUP_MEMBERS -> $GROUP_HUB tcp/$HUB_PORT unidirectional"
  fi

  # A loomgraph-members peer reaches nothing else, including both MacBooks.
  if [ -n "$members_group" ]; then
    verify_members_reach_only_hub "$members_group"
    verify_members_group_hygiene
  fi

  # Operator retains mesh SSH to the hub (and the sandbox peer, when configured).
  if [ -n "$macs_group" ] && [ -n "$hub_group" ] && [ -n "$sandbox_group" ] &&
     operator_path_ok "$macs_group" "$hub_group" "$sandbox_group"; then
    pass "operator retains hub tcp/$HUB_PORT, hub tcp/$SSH_PORT and sandbox tcp/$SSH_PORT"
  else
    fail "operator access policies are incomplete (see warnings above)"
  fi

  # Default is disabled, not deleted.
  if nbj policy-id "$POLICIES_JSON" "$POLICY_DEFAULT" > /dev/null; then
    if nbj policy-enabled "$POLICIES_JSON" "$POLICY_DEFAULT"; then
      fail "\"$POLICY_DEFAULT\" is still ENABLED (All -> All, every port)"
    else
      pass "\"$POLICY_DEFAULT\" is present and disabled"
    fi
  else
    fail "\"$POLICY_DEFAULT\" has been DELETED - it must remain, disabled, for one-call rollback"
  fi

  # The stale auto-created policy is gone, when one was named.
  if [ -z "$POLICY_DEAD" ]; then
    info "NETBIRD_DEAD_POLICY is empty - stale-policy criterion not checked"
  elif nbj policy-id "$POLICIES_JSON" "$POLICY_DEAD" > /dev/null; then
    fail "stale policy \"$POLICY_DEAD\" still exists"
  else
    pass "stale policy \"$POLICY_DEAD\" is gone"
  fi

  if [ "$DO_PROBE" = "yes" ]; then
    step "Reachability probes"
    if [ "$FROM_MEMBER" = "yes" ]; then
      info "running from a $GROUP_MEMBERS peer: the MacBooks must be unreachable from here"
      verify_member_isolation
    else
      verify_hub_health
      info "the negative criteria (a member peer reaching nothing but the hub) cannot be"
      info "proven from this machine. Re-run on a $GROUP_MEMBERS peer: netbird-acl.sh --verify --from-member"
    fi
  else
    info "network probes skipped (--no-probe): the API state above is all that was checked"
  fi

  printf '\n%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  if [ "$FAIL_COUNT" -ne 0 ]; then
    printf 'Acceptance: FAIL\n'
    return 1
  fi
  printf 'Acceptance (API side): PASS\n'
  printf '\nStill to confirm by hand from the operator machine:\n'
  printf '  netbird status --detail | grep -E "Peers count|Status:"\n'
  if [ -n "$HUB_SSH" ]; then
    printf '  ssh %s hostname                            # expect the hub host\n' "$HUB_SSH"
  fi
  if [ -n "$SANDBOX_SSH" ]; then
    printf '  ssh %s hostname                            # expect the sandbox host\n' "$SANDBOX_SSH"
  fi
  printf '  curl -s http://%s:%s%s                   # read the BODY\n' "$HUB_PEER_IP" "$HUB_PORT" "$HEALTH_PATH"
  printf 'And, from a %s peer once one has been enrolled:\n' "$GROUP_MEMBERS"
  printf '  netbird-acl.sh --verify --from-member\n'
}

# ---------------------------------------------------------------- main

main() {
  # Checked here, not at assignment, so --help still works without a hub.env and
  # the message can name the file to edit.
  require_var NETBIRD_API "$API_BASE" "NetBird management API base URL, including /api"
  require_var LOOMGRAPH_HUB_IP "$HUB_PEER_IP" "mesh IP of the peer running lg-hub"
  if [ "$FROM_MEMBER" = "yes" ] && [ -z "${MAC_PEER_IPS[0]:-}" ]; then
    die "LOOMGRAPH_MAC_IPS is not set (the peers a member must NOT reach). --from-member proves nothing without them. Set it in $ENV_FILE."
  fi

  case "$MODE" in
    dry-run) log "MODE: DRY-RUN (no changes; pass --apply to converge)" ;;
    apply)   log "MODE: APPLY" ;;
    verify)  log "MODE: VERIFY (read-only)" ;;
  esac
  log "API:  $API_BASE"

  load_token
  refresh_state

  if [ "$MODE" = "verify" ]; then
    verify
  else
    converge
  fi
}

main
