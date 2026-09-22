#!/bin/sh
# Builds dist/second-brain-<version>.xpi and dist/update.json (the file Zotero checks for updates).
set -e
cd "$(dirname "$0")"
(cd editor-src && npm install --silent && npm run build --silent)
(cd engine-src && npm install --silent --ignore-scripts && npm run build --silent)
version=$(node -p 'require("./manifest.json").version')
mkdir -p dist
rm -f "dist/second-brain-$version.xpi"
zip -qr "dist/second-brain-$version.xpi" manifest.json bootstrap.js content locale -x '*.DS_Store'
hash=$(shasum -a 256 "dist/second-brain-$version.xpi" | cut -d' ' -f1)
cat > dist/update.json <<JSON
{
  "addons": {
    "second-brain@frimpsjoe.local": {
      "updates": [{
        "version": "$version",
        "update_link": "https://github.com/frimpsjoek/zotero-second-brain/releases/download/v$version/second-brain-$version.xpi",
        "update_hash": "sha256:$hash",
        "applications": { "zotero": { "strict_min_version": "7.0", "strict_max_version": "10.*" } }
      }]
    }
  }
}
JSON
echo "dist/second-brain-$version.xpi"
