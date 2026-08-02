#!/usr/bin/env node
/**
 * convert-images-to-webp.mjs
 *
 * One-shot batch converter: re-encodes every `.jpg`, `.jpeg`, and `.png`
 * under `apps/funnel/public/images/` to WebP
 * (quality=78, effort=5) and deletes the original raster.
 *
 * Rationale: the funnel app serves assets from `apps/funnel/public/` and the
 * repo policy is "WebP only" for all JPG/PNG photo/UI assets.
 *
 * Quality settings (q=78, effort=5) match the encoding standard established
 * in quick-260417-sir (commit f17771e)  -  visually lossless for photography,
 * averaging ~85% byte reduction on JPGs and ~95% on PNGs.
 *
 * Usage:
 *   # from repo root (sharp resolved from the repo-root node_modules)
 *   node scripts/convert-images-to-webp.mjs
 *
 *   # if running from a worktree without its own node_modules, point NODE_PATH
 *   # at the main repo's node_modules:
 *   NODE_PATH=/path/to/your_project/node_modules \
 *     node scripts/convert-images-to-webp.mjs
 *
 * Safety:
 *   - Skips any file already ending in `.webp` (will never re-encode the
 *     already-optimized OTO1_TESTIMONIAL.webp, etc.).
 *   - Never descends into `node_modules` (defensive check).
 *   - Idempotent: a second run finds nothing to convert.
 *   - NOT wired into package.json because it mutates public assets
 *     irreversibly (deletes the JPG/PNG sources on success).
 */

import sharp from 'sharp';
import { readdir, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOTS = [
  'apps/funnel/public/images',
];

const RASTER_EXTS = new Set(['.jpg', '.jpeg', '.png']);

/**
 * Recursively collect all raster files under `dir`.
 * Returns absolute-ish paths relative to cwd.
 */
async function collectRasters(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`skip (missing): ${dir}`);
      return out;
    }
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue; // defensive
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectRasters(full);
      out.push(...nested);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (RASTER_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

async function fileSize(path) {
  const s = await stat(path);
  return s.size;
}

function webpPathFor(srcPath) {
  const ext = extname(srcPath);
  return srcPath.slice(0, -ext.length) + '.webp';
}

async function convertOne(src) {
  const dst = webpPathFor(src);
  const oldBytes = await fileSize(src);
  await sharp(src).webp({ quality: 78, effort: 5 }).toFile(dst);
  const newBytes = await fileSize(dst);
  await unlink(src);
  console.log(
    `converted: ${src} -> ${dst} (${oldBytes} -> ${newBytes} bytes, ${((1 - newBytes / oldBytes) * 100).toFixed(1)}% smaller)`,
  );
  return { oldBytes, newBytes };
}

async function main() {
  let totalOld = 0;
  let totalNew = 0;
  let count = 0;
  const failures = [];

  for (const root of ROOTS) {
    console.log(`\n=== scanning ${root} ===`);
    const files = await collectRasters(root);
    console.log(`found ${files.length} raster file(s) under ${root}`);
    for (const src of files) {
      try {
        const { oldBytes, newBytes } = await convertOne(src);
        totalOld += oldBytes;
        totalNew += newBytes;
        count += 1;
      } catch (err) {
        console.error(`FAILED: ${src}  -  ${err.message}`);
        failures.push({ src, message: err.message });
      }
    }
  }

  console.log('\n=== summary ===');
  console.log(`converted: ${count} file(s)`);
  console.log(`old total: ${totalOld} bytes (${(totalOld / 1024).toFixed(1)} KB)`);
  console.log(`new total: ${totalNew} bytes (${(totalNew / 1024).toFixed(1)} KB)`);
  console.log(
    `saved:     ${totalOld - totalNew} bytes (${((totalOld - totalNew) / 1024).toFixed(1)} KB, ${totalOld ? (((totalOld - totalNew) / totalOld) * 100).toFixed(1) : '0.0'}% reduction)`,
  );
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f.src}: ${f.message}`);
    process.exit(1);
  }
}

await main();
