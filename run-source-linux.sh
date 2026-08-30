#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_root"

if [[ ! -x ./node_modules/.bin/electron ]]; then
  printf '%s\n' 'Locked project dependencies are missing. Run npm ci, then launch again.' >&2
  exit 1
fi

printf '%s\n' 'Staging the native filesystem helper and metadata runtime...'
npm run package:stage-tools

printf '%s\n' 'Building Meta Mover from source...'
npm run build:dev

printf '%s\n' 'Launching Meta Mover with Electron sandboxing enabled...'
exec ./node_modules/.bin/electron .
