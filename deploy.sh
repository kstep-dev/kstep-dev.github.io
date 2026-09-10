#!/bin/bash
# Publish the site: build it, refuse to publish a playground image that does not speak the
# page's protocol, and force-push site/ as the gh-pages branch; history is not kept there.
#   ./deploy.sh
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)

"$W/build.sh"

# Refuse to publish a page whose playground image does not speak its protocol.
NODE=$(ls "$W"/build/emsdk/node/*/bin/node 2>/dev/null | head -1 || command -v node)
"$NODE" --wasm-lazy-compilation "$W/check.mjs" "$W/site/data.json" || { echo "deploy aborted: rebuild the playground image from the current kmod and user.c"; exit 1; }

version=$(python3 -c "import json;print(json.load(open('$W/site/data.json'))['version'])")
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -r "$W/site/." "$tmp/"
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" -c user.name="deploy.sh" -c user.email="deploy@kstep" commit -q -m "Deploy $version"
git -C "$tmp" push -q --force "$(git -C "$W" remote get-url origin)" gh-pages
echo "pushed gh-pages ($version)"
