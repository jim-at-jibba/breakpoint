#!/usr/bin/env bash
# docs/agents/check.sh - the Check loop2 runs after every Ticket (exit 0 = done;
# the last 60 lines go back to the agent otherwise).
#
# Mirrors CI's required job (.github/workflows/ci.yml "check"): lint, types and
# unit tests, which include the Docs drift check (src/shared/cli-reference.test.ts).
# Left out: test:e2e. CI runs it non-blocking (flaky on runners, issue #47), and it
# launches the real Electron app, which clashes with a running Breakpoint.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export CI=1 FORCE_COLOR=0

step() { printf '\n==> %s\n' "$*"; "$@"; }

# A fresh worktree has no node_modules, and no worktree hook installs them.
# npm ci is lockfile-exact; it only writes node_modules (ignored).
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
	step npm ci
fi

step npm run lint
step npm run typecheck
step npm run test:unit

echo
echo "check: ok"
