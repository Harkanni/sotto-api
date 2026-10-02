#!/usr/bin/env bash
# Restores node_modules for sandboxes that can't reach the npm registry (the coding agent's cloud
# sandbox). CI's `sync` job publishes a snapshot of every workspace's node_modules to the
# `dev-cache` release, keyed by the manifests + pnpm-lock.yaml. This downloads the matching one
# through the GitHub API.
#
#   GH_TOKEN=<token> scripts/agent-deps.sh
#
# Humans with npm access don't need this: run `pnpm install` instead.
set -euo pipefail
cd "$(dirname "$0")/.."
export LC_ALL=C # the same file order as CI, so the key matches

repo="${GITHUB_REPOSITORY:-Harkanni/sotto-api}"
key=$(cat package.json pnpm-workspace.yaml pnpm-lock.yaml apps/*/package.json packages/*/package.json |
  sha256sum | cut -c1-16)
name="node_modules-linux-x64-$key.tar.gz"

if [ -f node_modules/.agent-deps-key ] && [ "$(cat node_modules/.agent-deps-key)" = "$key" ]; then
  echo "node_modules already matches $key"
  exit 0
fi

id=$(curl -fsSL -H "Authorization: Bearer ${GH_TOKEN:?set GH_TOKEN}" \
  "https://api.github.com/repos/$repo/releases/tags/dev-cache" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).assets.find(a=>a.name===process.argv[1]);process.stdout.write(a?String(a.id):'')})" "$name")

if [ -z "$id" ]; then
  echo "No snapshot $name yet. Push the branch and let CI's sync job publish it, then rerun." >&2
  exit 1
fi

tmp=$(mktemp)
curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/octet-stream" -o "$tmp" \
  "https://api.github.com/repos/$repo/releases/assets/$id"
rm -rf node_modules apps/*/node_modules packages/*/node_modules
tar -xzf "$tmp"
rm -f "$tmp"
echo "$key" > node_modules/.agent-deps-key
echo "Restored node_modules from $name"
