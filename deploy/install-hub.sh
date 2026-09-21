#!/usr/bin/env bash
#
# install-hub.sh - provision the loomgraph hub on the mesh host.
#
# Idempotent: safe to re-run. A second run against an already-provisioned host
# changes nothing and reports "no changes".
#
# Assumes node >= 22.13 and npm are ALREADY installed (developed against node
# v22.22.1, npm 10.9.4, systemd 257, Ubuntu 25.04). This script never installs
# or upgrades node.
#
# Refuses to proceed if:
#   - node < 22.13
#   - port 8369 is already bound by something that is not lg-hub.service
#   - the mesh interface is absent, or LOOMGRAPH_HUB_IP is not assigned to it
#
# PACKAGE SOURCE - read this before running.
#
# loomgraph is NOT published to the public npm registry: fetching
# https://registry.npmjs.org/loomgraph returns "Not found". `npm i -g loomgraph`
# (as the README currently documents) cannot work, so this script installs from
# a LOCAL artifact by default and never falls back to the registry for the
# loomgraph package itself.
#
# Build the artifact on a machine with the repo checked out:
#
#     npm ci
#     npm run build          # tsup -> dist/ ; the bins point at dist/, so this
#                            # is mandatory, `npm pack` will not build for you
#     npm pack               # produces loomgraph-<version>.tgz in the repo root
#     scp loomgraph-<version>.tgz <host>:/tmp/
#
# Then, on the host:
#
#     sudo LOOMGRAPH_PACKAGE=/tmp/loomgraph-<version>.tgz ./install-hub.sh
#
# With no LOOMGRAPH_PACKAGE set, the script looks for loomgraph-<version>.tgz
# beside itself, in the repo root, and in the current directory, then falls back
# to a built repo working tree (one containing dist/hub/cli.js). If it finds
# none of those it exits with instructions rather than letting npm emit a bare
# 404. Whichever source is used, its version must equal the pinned version.
#
# Note: loomgraph's own runtime dependencies (commander, execa, yaml, zod) still
# come from the registry, so the host needs network access to it.
#
# Usage: sudo LOOMGRAPH_PACKAGE=/tmp/loomgraph-0.1.0.tgz ./install-hub.sh
# Overrides (env): LOOMGRAPH_VERSION, LOOMGRAPH_PACKAGE

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

readonly SERVICE_NAME="lg-hub.service"
readonly SERVICE_USER="lghub"
readonly SERVICE_GROUP="lghub"
readonly DATA_DIR="/var/lib/lghub"
readonly UNIT_SRC="${SCRIPT_DIR}/lg-hub.service"
readonly UNIT_DST="/etc/systemd/system/${SERVICE_NAME}"
readonly BIN_PATH="/usr/bin/lg-hub"
# Deployment addresses come from deploy/hub.env (gitignored; copy
# deploy/hub.env.example). Nothing host-specific is baked into this script - a
# provisioning script that defaults to someone else's mesh IP binds the wrong
# address and the unit fails to start with a confusing error.
ENV_FILE="${LOOMGRAPH_HUB_ENV:-${SCRIPT_DIR}/hub.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

readonly MESH_IFACE="${LOOMGRAPH_MESH_IFACE:-wt0}"
readonly MESH_IP="${LOOMGRAPH_HUB_IP:-}"
readonly HUB_PORT="${LOOMGRAPH_HUB_PORT:-8369}"
readonly MIN_NODE_MAJOR=22
readonly MIN_NODE_MINOR=13

# Pinned version fallback. The repo's package.json wins when this script is run
# from a checkout; never @latest either way.
DEFAULT_VERSION="0.1.0"

CHANGED=0
# Set by resolve_package_source. A global rather than a command substitution so
# that a failure inside it exits the script instead of a subshell.
PACKAGE_SOURCE=""

log()  { printf 'install-hub: %s\n' "$*"; }
step() { printf 'install-hub: [changed] %s\n' "$*"; CHANGED=$((CHANGED + 1)); }
die()  { printf 'install-hub: FATAL %s\n' "$*" >&2; exit 1; }

# --- preconditions ----------------------------------------------------------

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (try: sudo $0)"
  fi
}

require_commands() {
  local missing=()
  local cmd
  for cmd in node npm tar ss ip systemctl useradd groupadd install; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "missing required commands: ${missing[*]}"
  fi
  if ! command -v runuser >/dev/null 2>&1 && ! command -v sudo >/dev/null 2>&1; then
    die "need runuser or sudo to drop privileges to ${SERVICE_USER}; neither is installed"
  fi
}

# Never run lg-hub as root. node:sqlite creates hub.db-wal and hub.db-shm
# alongside the database on first write; if root creates them, they end up
# root-owned and the service - which runs as lghub under ProtectSystem=strict -
# can no longer write its own store. Every lg-hub invocation goes through here.
run_as_hub() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    sudo -u "$SERVICE_USER" -- "$@"
  fi
}

check_node_version() {
  local raw major minor
  raw="$(node -v)"          # e.g. v22.22.1
  raw="${raw#v}"
  major="${raw%%.*}"
  minor="${raw#*.}"
  minor="${minor%%.*}"
  if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
    die "could not parse node version from 'node -v' output: $(node -v)"
  fi
  if [ "$major" -lt "$MIN_NODE_MAJOR" ] ||
     { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; }; then
    die "node $(node -v) is too old; loomgraph requires >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (node:sqlite is only usable unflagged from 22.13). This script does not install node."
  fi
  log "node $(node -v) satisfies >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}"
}

check_config() {
  if [ -z "$MESH_IP" ]; then
    die "LOOMGRAPH_HUB_IP is not set (the mesh address lg-hub binds). Copy deploy/hub.env.example to ${ENV_FILE} and fill it in, or export it for this run."
  fi
}

check_mesh() {
  if ! ip -o link show dev "$MESH_IFACE" >/dev/null 2>&1; then
    die "interface ${MESH_IFACE} does not exist - NetBird is not up. The unit binds ${MESH_IP} and will not start without it."
  fi
  if ! ip -o -4 addr show dev "$MESH_IFACE" | grep -Fq " ${MESH_IP}/"; then
    die "${MESH_IP} is not assigned to ${MESH_IFACE}. Check 'ip -4 addr show dev ${MESH_IFACE}' and the NetBird peer configuration."
  fi
  log "${MESH_IP} is assigned to ${MESH_IFACE}"
}

check_port_free() {
  local holders
  holders="$(ss -ltnH "sport = :${HUB_PORT}" 2>/dev/null || true)"
  if [ -z "$holders" ]; then
    log "port ${HUB_PORT} is free"
    return 0
  fi
  # Our own service already listening is the expected state on a re-run.
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "port ${HUB_PORT} is held by ${SERVICE_NAME} (already provisioned)"
    return 0
  fi
  printf '%s\n' "$holders" >&2
  die "port ${HUB_PORT} is already bound by a process that is not ${SERVICE_NAME} (listeners above). Refusing to provision over it."
}

# --- provisioning steps -----------------------------------------------------

resolve_version() {
  local pkg_json="${SCRIPT_DIR}/../package.json"
  if [ -n "${LOOMGRAPH_VERSION:-}" ]; then
    printf '%s' "$LOOMGRAPH_VERSION"
    return 0
  fi
  if [ -f "$pkg_json" ]; then
    local v
    v="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version ?? ""))' "$pkg_json")"
    if [ -n "$v" ]; then
      printf '%s' "$v"
      return 0
    fi
  fi
  printf '%s' "$DEFAULT_VERSION"
}

installed_version() {
  local root
  root="$(npm root -g 2>/dev/null || true)"
  if [ -z "$root" ] || [ ! -f "${root}/loomgraph/package.json" ]; then
    return 0
  fi
  node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version ?? ""))' \
    "${root}/loomgraph/package.json" 2>/dev/null || true
}

ensure_user() {
  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
    step "created system group ${SERVICE_GROUP}"
  fi
  if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system \
      --gid "$SERVICE_GROUP" \
      --home-dir "$DATA_DIR" \
      --no-create-home \
      --shell /usr/sbin/nologin \
      --comment "loomgraph hub service account" \
      "$SERVICE_USER"
    step "created system user ${SERVICE_USER} (no login shell)"
  fi
}

ensure_data_dir() {
  if [ ! -d "$DATA_DIR" ]; then
    install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$DATA_DIR"
    step "created ${DATA_DIR} (0750 ${SERVICE_USER}:${SERVICE_GROUP})"
    return 0
  fi
  local mode owner
  mode="$(stat -c '%a' "$DATA_DIR")"
  owner="$(stat -c '%U:%G' "$DATA_DIR")"
  if [ "$mode" != "750" ]; then
    chmod 0750 "$DATA_DIR"
    step "fixed ${DATA_DIR} mode ${mode} -> 750"
  fi
  if [ "$owner" != "${SERVICE_USER}:${SERVICE_GROUP}" ]; then
    chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$DATA_DIR"
    step "fixed ${DATA_DIR} owner ${owner} -> ${SERVICE_USER}:${SERVICE_GROUP}"
  fi
}

# Read the version out of a packed tarball without unpacking it to disk.
tarball_version() {
  tar -xzOf "$1" package/package.json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",(d)=>{s+=d;}).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version ?? ""));}catch{}});'
}

# Sets PACKAGE_SOURCE. Never resolves to the public registry on its own:
# loomgraph is not published there.
resolve_package_source() {
  local want="$1" candidate found
  PACKAGE_SOURCE=""

  if [ -n "${LOOMGRAPH_PACKAGE:-}" ]; then
    if [ -e "$LOOMGRAPH_PACKAGE" ]; then
      PACKAGE_SOURCE="$LOOMGRAPH_PACKAGE"
      log "package source: ${PACKAGE_SOURCE} (from LOOMGRAPH_PACKAGE)"
      return 0
    fi
    case "$LOOMGRAPH_PACKAGE" in
      /* | ./* | ../* | *.tgz | *.tar.gz)
        die "LOOMGRAPH_PACKAGE points at a path that does not exist: ${LOOMGRAPH_PACKAGE}"
        ;;
    esac
    # Not a path: treat as an npm spec. Opt-in only, and only meaningful
    # against a private registry.
    log "WARNING: LOOMGRAPH_PACKAGE='${LOOMGRAPH_PACKAGE}' is not an existing path, so it is"
    log "         being passed to npm as a package spec. loomgraph is NOT on the public"
    log "         registry, so this only works against a private/mirrored one."
    PACKAGE_SOURCE="$LOOMGRAPH_PACKAGE"
    return 0
  fi

  for candidate in \
    "${SCRIPT_DIR}/loomgraph-${want}.tgz" \
    "${SCRIPT_DIR}/../loomgraph-${want}.tgz" \
    "./loomgraph-${want}.tgz"; do
    if [ -f "$candidate" ]; then
      PACKAGE_SOURCE="$candidate"
      log "package source: ${PACKAGE_SOURCE} (auto-discovered tarball)"
      return 0
    fi
  done

  # A built working tree is acceptable; an unbuilt one is not - the bins point
  # at dist/ and npm will not run the build for us (there is no prepare script).
  if [ -f "${SCRIPT_DIR}/../package.json" ]; then
    found="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
    if [ -f "${found}/dist/hub/cli.js" ]; then
      PACKAGE_SOURCE="$found"
      log "package source: ${PACKAGE_SOURCE} (built repo working tree)"
      return 0
    fi
    die "found a repo working tree at ${found} but ${found}/dist/hub/cli.js is missing - run 'npm ci && npm run build' there first, or build a tarball with 'npm pack' and pass LOOMGRAPH_PACKAGE=/path/to/loomgraph-${want}.tgz"
  fi

  die "no loomgraph package to install. loomgraph is NOT published to npm, so there is nothing to fetch. On a machine with the repo: 'npm ci && npm run build && npm pack' produces loomgraph-${want}.tgz; copy it to this host and re-run with LOOMGRAPH_PACKAGE=/path/to/loomgraph-${want}.tgz"
}

ensure_package() {
  local want have src_version
  want="$1"
  have="$(installed_version)"
  if [ "$have" = "$want" ]; then
    log "loomgraph ${want} already installed globally"
    return 0
  fi

  resolve_package_source "$want"

  # The pin has to mean something: check the artifact really is the version we
  # think we are installing, before npm touches the system.
  if [ -f "$PACKAGE_SOURCE" ]; then
    src_version="$(tarball_version "$PACKAGE_SOURCE")"
    if [ -z "$src_version" ]; then
      die "could not read a version from ${PACKAGE_SOURCE}; is it an 'npm pack' tarball?"
    fi
    if [ "$src_version" != "$want" ]; then
      die "version mismatch: ${PACKAGE_SOURCE} contains loomgraph ${src_version}, but the pinned version is ${want}. Set LOOMGRAPH_VERSION=${src_version} if that tarball is what you mean to install."
    fi
  elif [ -d "$PACKAGE_SOURCE" ]; then
    src_version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version ?? ""))' "${PACKAGE_SOURCE}/package.json")"
    if [ "$src_version" != "$want" ]; then
      die "version mismatch: ${PACKAGE_SOURCE} is loomgraph ${src_version}, but the pinned version is ${want}"
    fi
  fi

  log "installing loomgraph ${want} from ${PACKAGE_SOURCE} (pinned; never @latest)"
  npm install -g --no-fund --no-audit -- "$PACKAGE_SOURCE"
  have="$(installed_version)"
  if [ "$have" != "$want" ]; then
    die "after installing ${PACKAGE_SOURCE} the global loomgraph reports version '${have:-<none>}', expected '${want}'"
  fi
  step "installed loomgraph ${want} globally from ${PACKAGE_SOURCE}"
}

ensure_bin_path() {
  local prefix real
  prefix="$(npm prefix -g)"
  real="${prefix}/bin/lg-hub"
  if [ ! -x "$real" ]; then
    die "npm reports global prefix ${prefix} but ${real} is missing or not executable"
  fi
  if [ "$real" = "$BIN_PATH" ]; then
    log "${BIN_PATH} provided directly by the npm global prefix"
    return 0
  fi
  if [ -L "$BIN_PATH" ] && [ "$(readlink -f "$BIN_PATH")" = "$(readlink -f "$real")" ]; then
    log "${BIN_PATH} already links to ${real}"
    return 0
  fi
  if [ -e "$BIN_PATH" ] && [ ! -L "$BIN_PATH" ]; then
    die "${BIN_PATH} exists and is not a symlink; refusing to replace it. The unit's ExecStart expects ${BIN_PATH}."
  fi
  ln -sfn "$real" "$BIN_PATH"
  step "linked ${BIN_PATH} -> ${real}"
}

ensure_db() {
  if [ -f "${DATA_DIR}/hub.db" ]; then
    log "${DATA_DIR}/hub.db already exists"
    check_store_ownership
    return 0
  fi
  # --data-dir is passed explicitly: resolveDataDir() would otherwise fall back
  # to $HOME/.local/share/loomgraph-hub, which is not where the unit looks.
  run_as_hub "$BIN_PATH" init --data-dir "$DATA_DIR"
  if [ ! -f "${DATA_DIR}/hub.db" ]; then
    die "'lg-hub init' completed but ${DATA_DIR}/hub.db was not created"
  fi
  step "initialised ${DATA_DIR}/hub.db as ${SERVICE_USER}"
  check_store_ownership
}

# A root-owned hub.db-wal or hub.db-shm means somebody ran lg-hub as root. The
# service cannot write through it, so surface it rather than let the unit fail
# with an opaque SQLITE_CANTOPEN later.
check_store_ownership() {
  local f owner stray=0
  for f in "${DATA_DIR}/hub.db" "${DATA_DIR}/hub.db-wal" "${DATA_DIR}/hub.db-shm"; do
    [ -e "$f" ] || continue
    owner="$(stat -c '%U' "$f")"
    if [ "$owner" != "$SERVICE_USER" ]; then
      printf 'install-hub: %s is owned by %s, expected %s\n' "$f" "$owner" "$SERVICE_USER" >&2
      stray=1
    fi
  done
  if [ "$stray" -eq 1 ]; then
    die "store files are not owned by ${SERVICE_USER} (see above). Something ran lg-hub as root. Stop the service, 'chown -R ${SERVICE_USER}:${SERVICE_GROUP} ${DATA_DIR}', and re-run."
  fi
}

ensure_unit() {
  if [ ! -f "$UNIT_SRC" ]; then
    die "unit file not found next to this script: ${UNIT_SRC}"
  fi

  # The unit ships as a TEMPLATE: @MESH_IP@ and @HUB_PORT@ are substituted here
  # so the installed file carries concrete values. systemd could expand an
  # EnvironmentFile instead, but then `systemctl cat` shows a variable and the
  # operator has to go find what it resolved to - exactly the wrong trade when
  # the value being hidden is the bind address.
  local rendered
  rendered="$(mktemp)"
  # shellcheck disable=SC2064  # expand now: the path must survive this function
  trap "rm -f '${rendered}'" RETURN
  sed -e "s|@MESH_IP@|${MESH_IP}|g" -e "s|@HUB_PORT@|${HUB_PORT}|g" "$UNIT_SRC" > "$rendered"
  if grep -q '@MESH_IP@\|@HUB_PORT@' "$rendered"; then
    die "unit template still contains an unsubstituted placeholder after rendering"
  fi

  local unit_changed=0
  if ! cmp -s "$rendered" "$UNIT_DST"; then
    install -o root -g root -m 0644 "$rendered" "$UNIT_DST"
    systemctl daemon-reload
    step "installed ${UNIT_DST}"
    unit_changed=1
  else
    log "${UNIT_DST} already up to date"
  fi

  if ! systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl enable "$SERVICE_NAME"
    step "enabled ${SERVICE_NAME}"
  fi

  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    systemctl start "$SERVICE_NAME"
    step "started ${SERVICE_NAME}"
  elif [ "$unit_changed" -eq 1 ] || [ "$CHANGED" -gt 0 ]; then
    systemctl restart "$SERVICE_NAME"
    step "restarted ${SERVICE_NAME} (unit or package changed)"
  else
    log "${SERVICE_NAME} already running with the current unit and package"
  fi
}

report() {
  if [ "$CHANGED" -eq 0 ]; then
    log "no changes - host already provisioned"
  else
    log "${CHANGED} change(s) applied"
  fi
  log "verify with:"
  log "  systemctl status ${SERVICE_NAME}"
  log "  ss -tln | grep ${HUB_PORT}    # expect ${MESH_IP}:${HUB_PORT}, nothing on 0.0.0.0:${HUB_PORT}"
  log ""
  log "the web UI is disabled (--no-ui in the unit); the JSON API is the only surface."
  log "NEVER run lg-hub as root - it would leave root-owned hub.db-wal/-shm and lock"
  log "the service out of its own store. Add a member like this:"
  log "  runuser -u ${SERVICE_USER} -- ${BIN_PATH} member add <name> --data-dir ${DATA_DIR}"
  log "note: the store sets no busy_timeout, so a member/export command issued while"
  log "the server is mid-ingest can fail with SQLITE_BUSY. Re-run it if it does."
}

main() {
  require_root
  require_commands
  check_config
  check_node_version
  check_mesh
  check_port_free

  local version
  version="$(resolve_version)"
  log "pinned loomgraph version: ${version}"

  ensure_user
  ensure_data_dir
  ensure_package "$version"
  ensure_bin_path
  ensure_db
  ensure_unit
  report
}

main "$@"
