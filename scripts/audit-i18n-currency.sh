#!/usr/bin/env bash
# Phase 1028 audit gate  -  fails if any hardcoded currency symbol (€ or $N)
# appears in a functional i18n string. Testimonial narrative tagged with
# __note: "intentional EUR" is exempt per D-10.
set -euo pipefail

FAIL=0
LOCALES="en cs lt lv el hr zh-TW ru"

for l in $LOCALES; do
  FILE="packages/i18n/messages/$l/oto.json"
  if [[ ! -f "$FILE" ]]; then
    echo "SKIP: $FILE not found"
    continue
  fi
  # Use Node to parse JSON and walk it, skipping any object that has
  # __note starting with "intentional EUR" (covers testimonials tagged
  # per Plans 02/03).
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$FILE', 'utf8'));
    const hits = [];
    function walk(node, path) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, path + '[' + i + ']'));
        return;
      }
      // Skip any object tagged as intentional EUR narrative
      if (typeof node.__note === 'string' && /intentional EUR/.test(node.__note)) return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '__note') continue;
        // Sibling-marker exemption: if parent has '<k>_note' tagged 'intentional EUR',
        // skip the corresponding sub-tree (e.g. testimonials_note marks testimonials)
        if (k.endsWith('_note') && typeof v === 'string' && /intentional EUR/.test(v)) continue;
        const siblingNote = node[k + '_note'];
        if (typeof siblingNote === 'string' && /intentional EUR/.test(siblingNote)) continue;
        if (typeof v === 'string') {
          if (/€|\\\$[0-9]/.test(v)) hits.push(path + '.' + k + ' = ' + JSON.stringify(v));
        } else {
          walk(v, path + '.' + k);
        }
      }
    }
    walk(data, '$l');
    if (hits.length) {
      console.error('FAIL ($l):');
      hits.forEach(h => console.error('  ' + h));
      process.exit(1);
    }
  " || FAIL=1
done

if [[ $FAIL -ne 0 ]]; then
  echo ""
  echo "AUDIT FAILED: hardcoded currency found in i18n functional strings."
  echo "Fix or tag with __note: 'intentional EUR  -  narrative (D-10)' if legitimate."
  exit 1
fi

echo "PASS: no hardcoded currency in i18n functional strings"
