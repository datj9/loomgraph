#!/usr/bin/env bash
#
# enroll-member.sh - the NetBird half of adding a colleague to the hub.
#
# A member needs TWO independent grants, and this script does only the first:
#
#   1. NETWORK  - their peer is in the loomgraph-members group, so packets to
#                 the hub port are allowed by the ACL. THIS SCRIPT.
#   2. IDENTITY - a hub token, so the hub answers them.
#                 `lg-hub member add <name>`, run on the hub host.
#
# Either alone is useless: a token without mesh access cannot reach the port,
# and mesh access without a token gets a 401. Revoking someone means undoing
# both - `lg-hub member revoke <keyId>` AND removing their peer from the group.
#
# Default mode is DRY-RUN. Nothing is written without --apply.
#
#   deploy/enroll-member.sh --new alice            dry-run a setup key
#   deploy/enroll-member.sh --new alice --apply    create it, print it once
#   deploy/enroll-member.sh --peer alices-mbp --apply   add an EXISTING peer
#   deploy/enroll-member.sh --list                 show the group's members
#
# The management API token is read from NETBIRD_TOKEN, an `nbtoken` helper, or
# the macOS Keychain, and is never printed, logged, or passed on a command line.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${LOOMGRAPH_HUB_ENV:-$SCRIPT_DIR/hub.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

API_BASE="${NETBIRD_API:-}"
KEYCHAIN_SERVICE="${NETBIRD_KEYCHAIN_SERVICE:-netbird-pat}"
GROUP_MEMBERS="${LOOMGRAPH_MEMBERS_GROUP:-loomgraph-members}"
HUB_IP="${LOOMGRAPH_HUB_IP:-}"
HUB_PORT="${LOOMGRAPH_HUB_PORT:-8369}"

# A setup key that never expires is a credential with no end date sitting in
# somebody's chat history. One-off plus a short window means a leaked key is
# useless by the time anyone finds it.
KEY_EXPIRY_SECONDS="${LOOMGRAPH_SETUP_KEY_EXPIRY:-86400}"

MODE="dry-run"
ACTION=""
TARGET=""
TOKEN=""

log()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf 'ERROR %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: enroll-member.sh (--new <name> | --peer <name-or-ip> | --list) [--apply]

  --new <name>    Create a one-off setup key that auto-joins the new peer to
                  the members group. Use for a colleague with no peer yet.
                  The key is printed ONCE and cannot be recovered.
  --peer <ref>    Add an EXISTING peer to the members group, by peer name,
                  hostname or mesh IP. Use when they are already on the mesh.
  --list          Print the members group's current peers. Read-only.
  --apply         Actually write. Without it, everything is a dry-run.

Configuration comes from deploy/hub.env - see hub.env.example.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --new)   ACTION="new";  TARGET="${2:-}"; [ -n "$TARGET" ] || die "--new needs a name"; shift ;;
    --peer)  ACTION="peer"; TARGET="${2:-}"; [ -n "$TARGET" ] || die "--peer needs a name or IP"; shift ;;
    --list)  ACTION="list" ;;
    --apply) MODE="apply" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$ACTION" ] || { usage >&2; die "pick one of --new, --peer or --list"; }
[ -n "$API_BASE" ] || die "NETBIRD_API is not set. Fill in $ENV_FILE (copy hub.env.example)."

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
  [ -n "$TOKEN" ] || die "the API token resolved to an empty string"
}

# The token goes to curl through a --config file on STDIN. Never as -H on the
# command line: argv is world-readable in `ps` for the life of the process.
api() {
  local method="$1" path="$2" body="${3:-}"
  {
    printf 'url = "%s%s"\n' "$API_BASE" "$path"
    printf 'header = "Authorization: Token %s"\n' "$TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    printf 'request = "%s"\n' "$method"
    printf 'silent\nshow-error\nfail\n'
    if [ -n "$body" ]; then
      printf 'data-binary = "%s"\n' "@-"
    fi
  } > "$CURL_CONFIG"

  if [ -n "$body" ]; then
    printf '%s' "$body" | curl --config "$CURL_CONFIG" ||
      die "$method $path failed"
  else
    curl --config "$CURL_CONFIG" < /dev/null || die "$method $path failed"
  fi
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/enroll-member.XXXXXX")"
CURL_CONFIG="$WORK_DIR/curl.conf"
trap 'rm -rf "$WORK_DIR"' EXIT

group_id() {
  api GET /groups > "$WORK_DIR/groups.json"
  GROUP_NAME="$GROUP_MEMBERS" python3 - "$WORK_DIR/groups.json" <<'PY'
import json, os, sys
want = os.environ["GROUP_NAME"]
for g in json.load(open(sys.argv[1])):
    if g["name"] == want:
        print(g["id"]); raise SystemExit(0)
raise SystemExit(1)
PY
}

main() {
  load_token
  log "API:  $API_BASE"

  local gid
  gid="$(group_id)" || die "group \"$GROUP_MEMBERS\" does not exist - run netbird-acl.sh first"

  case "$ACTION" in
    list)
      step "peers in \"$GROUP_MEMBERS\" ($gid)"
      api GET /peers > "$WORK_DIR/peers.json"
      GROUP_ID="$gid" python3 - "$WORK_DIR/groups.json" "$WORK_DIR/peers.json" <<'PY'
import json, os, sys
gid = os.environ["GROUP_ID"]
groups = json.load(open(sys.argv[1]))
peers = {p["id"]: p for p in json.load(open(sys.argv[2]))}
members = next(g for g in groups if g["id"] == gid).get("peers") or []
if not members:
    print("  (none yet)")
for m in members:
    pid = m["id"] if isinstance(m, dict) else m
    p = peers.get(pid, {})
    print("  %-24s %-16s %s" % (p.get("name", pid), p.get("ip", "?"),
                                "connected" if p.get("connected") else "offline"))
PY
      ;;

    new)
      step "one-off setup key \"$TARGET\", auto-joining \"$GROUP_MEMBERS\""
      local body
      body="$(GROUP_ID="$gid" NAME="$TARGET" EXPIRY="$KEY_EXPIRY_SECONDS" python3 -c '
import json, os
print(json.dumps({
    "name": os.environ["NAME"],
    "type": "one-off",
    "expires_in": int(os.environ["EXPIRY"]),
    "usage_limit": 1,
    "ephemeral": False,
    "auto_groups": [os.environ["GROUP_ID"]],
}))')"
      if [ "$MODE" != "apply" ]; then
        info "DRY-RUN POST ${API_BASE}/setup-keys"
        info "body: $body"
        info "re-run with --apply to create it"
        return 0
      fi
      api POST /setup-keys "$body" > "$WORK_DIR/key.json"
      local key
      key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["key"])' "$WORK_DIR/key.json")"
      print_member_instructions "$TARGET" "$key"
      ;;

    peer)
      step "add existing peer \"$TARGET\" to \"$GROUP_MEMBERS\""
      api GET /peers > "$WORK_DIR/peers.json"
      local pid
      pid="$(REF="$TARGET" python3 - "$WORK_DIR/peers.json" <<'PY'
import json, os, sys
ref = os.environ["REF"]
hits = [p for p in json.load(open(sys.argv[1]))
        if ref in (p.get("name"), p.get("hostname"), p.get("ip"), p.get("id"))]
if len(hits) != 1:
    raise SystemExit(1)
print(hits[0]["id"])
PY
)" || die "no single peer matched \"$TARGET\" - check the name with: netbird-acl.sh --verify, or the NetBird console"

      # A group PUT REPLACES the peer list, so the existing members are read
      # and sent back with the new one appended. Sending just the new id would
      # silently evict everyone already in the group.
      local body
      body="$(GROUP_ID="$gid" NEW_PEER="$pid" NAME="$GROUP_MEMBERS" python3 - "$WORK_DIR/groups.json" <<'PY'
import json, os, sys
gid, new = os.environ["GROUP_ID"], os.environ["NEW_PEER"]
g = next(x for x in json.load(open(sys.argv[1])) if x["id"] == gid)
peers = [p["id"] if isinstance(p, dict) else p for p in (g.get("peers") or [])]
if new not in peers:
    peers.append(new)
print(json.dumps({"name": os.environ["NAME"], "peers": peers}))
PY
)"
      if [ "$MODE" != "apply" ]; then
        info "DRY-RUN PUT ${API_BASE}/groups/${gid}"
        info "body: $body"
        info "re-run with --apply"
        return 0
      fi
      api PUT "/groups/${gid}" "$body" > /dev/null
      info "peer \"$TARGET\" ($pid) is now in \"$GROUP_MEMBERS\""
      printf '\nThey still need a hub token. On the hub host:\n'
      printf '  sudo -u lghub lg-hub member add <name> --data-dir /var/lib/lghub\n'
      ;;
  esac
}

print_member_instructions() {
  local name="$1" key="$2"
  cat <<EOF

Setup key for ${name} (shown ONCE - it is not recoverable):

  ${key}

Valid for $((KEY_EXPIRY_SECONDS / 3600))h, single use. Send it over a channel where the value can be
destroyed afterwards, and delete it there once they are connected.

--- give them this ---------------------------------------------------------

1. Install NetBird: https://docs.netbird.io/how-to/installation

2. Join the mesh. 'netbird up' SILENTLY IGNORES these flags if the client is
   already connected - it prints "Already connected" and drops them - so bring
   it down first. There is no 'netbird set'.

     netbird down
     netbird up --setup-key ${key} \\
       --management-url ${API_BASE%/api}

3. Confirm they can reach the hub, and nothing else:

     curl -s http://${HUB_IP}:${HUB_PORT}/v1/health     # expect {"ok":true,...}

4. Enroll against the hub with the token from 'lg-hub member add':

     lg enroll http://${HUB_IP}:${HUB_PORT} <their-hub-token>

5. Opt in PER REPOSITORY. Nothing syncs until they do this, in each repo:

     lg sync --enable

   Have them read docs/hub-onboarding.md BEFORE step 5, not after. What
   reaches the hub is readable by every member and can never be deleted.

----------------------------------------------------------------------------

Then, from THEIR machine, prove the ACL holds:

  deploy/enroll-member.sh --list
  deploy/netbird-acl.sh --verify --from-member

The second one is the only way to check the negative criteria: a member peer
must reach the hub on tcp/${HUB_PORT} and nothing else, including your MacBooks.
It proves nothing from the operator machine, which is in "personal macbooks"
and is supposed to reach everything.
EOF
}

main
