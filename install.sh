#!/usr/bin/env bash
# Install board-lab into a DSH profile from this checkout.
set -euo pipefail
PROFILE="${1:-web}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "board-lab -> profile '$PROFILE' ($DIR)"
exec dsh plugin --profile "$PROFILE" add "$DIR"
