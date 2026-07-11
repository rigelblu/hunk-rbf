#!/usr/bin/env bash

# Publish this project's rb-drive CONTENTS into a public share (.rb-drive-public-share/)
# with rsync, withholding VCS internals and credential-shaped files so no secret can ride
# along to a public folder. Documents are shared deliberately; only secrets are withheld.
# The destination must be a pre-created symlink to your public share location.
#
# For a private, secrets-and-all backup instead, use sync-rb-drive.sh.

set -euo pipefail

# Walk up from the script to the product root — the first ancestor holding rb-drive.
# This works at any nesting depth, so the script needs no per-project path tweaks.
find_product_root() {
  local dir="$1"
  while :; do
    [ -e "$dir/rb-drive" ] && {
      printf '%s\n' "$dir"
      return 0
    }
    [ "$dir" = "/" ] && return 1
    dir="$(dirname "$dir")"
  done
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
product_root="$(find_product_root "$script_dir")" ||
  {
    echo "error: no rb-drive found in any directory above $script_dir" >&2
    exit 1
  }
cd "$product_root"

# Cap how many files a single mirror may delete, as a backstop against a runaway
# --delete. Raise it for a legitimately large cleanup: RB_DRIVE_MAX_DELETE=500 ...
max_delete="${RB_DRIVE_MAX_DELETE:-100}"

usage() {
  cat <<'USAGE'
Usage: scripts/sync-rb-drive-public.sh [--dry-run]

Publish rb-drive contents (agents/, projects/) into .rb-drive-public-share/ with rsync.
VCS internals and credential-shaped files are excluded; documents are shared deliberately.

Options:
  -n, --dry-run  Show what rsync would change, without writing or deleting.
  -h, --help     Show this help.

Environment:
  RB_DRIVE_MAX_DELETE  Max files the mirror may delete (default: 100).
USAGE
}

fail() {
  echo "error: $*" >&2
  exit 1
}

dry_run=false
for arg in "$@"; do
  case "$arg" in
  -n | --dry-run) dry_run=true ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) fail "unknown argument: $arg" ;;
  esac
done

# A real rb-drive store always contains projects/. Without this guard an empty or
# half-built source (e.g. a freshly re-created symlink before data syncs back) would
# make rsync --delete wipe the entire destination share.
[ -d "${product_root}/rb-drive/projects" ] ||
  fail "rb-drive/projects not found — refusing to mirror a missing or empty source with --delete"

# -L dereferences symlinks so the share holds real files; --delete mirrors the source
# exactly; --max-delete is the runaway-deletion backstop to the sentinel above.
# The array stays non-empty so "${rsync_opts[@]}" is safe under set -u on bash 3.2.
rsync_opts=(-avL --delete "--max-delete=${max_delete}")
if [ "$dry_run" = true ]; then
  rsync_opts+=(--dry-run)
fi

# Patterns withheld from the public share: VCS internals plus credential-shaped files,
# so a stray secret in rb-drive can never ride along to a public folder. This withholds
# only secrets, never documents — content is shared deliberately.
public_excludes=(
  --exclude='.git' --exclude='.jj'
  --exclude='.env*' --exclude='.netrc'
  --exclude='*.pem' --exclude='*.key' --exclude='*.p12' --exclude='*.pfx'
  --exclude='id_rsa*' --exclude='id_dsa*' --exclude='id_ecdsa*' --exclude='id_ed25519*'
  --exclude='*credential*' --exclude='*.keychain*'
)
rsync_opts+=("${public_excludes[@]}")

# Trailing slash on src: rsync copies the CONTENTS, so .agents/ and projects/ land directly
# at the share root (no rb-drive/ level) for easy public browsing.
dest="${product_root}/.rb-drive-public-share/"
src="${product_root}/rb-drive/"

# Require the destination to be a pre-created symlink (to the public share folder); otherwise
# rsync would silently mirror into a local, gitignored dir that never reaches the share.
[ -L "${dest%/}" ] || fail "${dest%/} is not a symlink — point it at your public share folder before syncing"

rsync "${rsync_opts[@]}" "$src" "$dest"
