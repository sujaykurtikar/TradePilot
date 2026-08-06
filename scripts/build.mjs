// Build script for the TradePilot MV3 extension.
//
// Why esbuild directly instead of the Vite tooling named in
// IMPLEMENTATION_PLAN.md §6.0/P1: MV3 requires per-entry output *format* —
// content scripts must be IIFE (no ESM support in content scripts), the
// service worker must be `type: module`. Vite's plugin ecosystem for this
// (@crxjs/vite-plugin) adds a large, fast-moving dependency surface for a
// feature esbuild's multi-entry API already covers directly: distinct
// `format`/`bundle` per outfile, zero plugin config. Same underlying
// bundler Vite itself uses. This is a build-tool substitution only — every
// architectural decision in the plan (MAIN/ISOLATED split, Shadow DOM,
// bridge quarantine, IIFE content scripts, ESM service worker) is
// unchanged and enforced by this script's per-entry `format` below.
import { build, context } from 'esbuild';
import { mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const entries = [
  {
    // ISOLATED world: Shadow DOM widget, messaging, storage. Knows nothing
    // about TradingView/Kotak internals (§5.1).
    entryPoints: [path.join(root, 'src/content/index.ts')],
    outfile: path.join(dist, 'content.js'),
    format: 'iife',
    bundle: true,
    target: 'chrome111',
  },
  {
    // MAIN world: the ONLY code that touches host-page chart internals
    // (§5.1). Quarantined by eslint's no-restricted-globals to src/bridge/**.
    entryPoints: [path.join(root, 'src/bridge/mainWorld.ts')],
    outfile: path.join(dist, 'bridge.js'),
    format: 'iife',
    bundle: true,
    target: 'chrome111',
  },
  {
    // Service worker — MV3 requires `type: module` in the manifest, so this
    // is the one entry that may be ESM output.
    entryPoints: [path.join(root, 'src/background/index.ts')],
    outfile: path.join(dist, 'background.js'),
    format: 'esm',
    bundle: true,
    target: 'chrome111',
  },
  {
    entryPoints: [path.join(root, 'popup/popup.ts')],
    outfile: path.join(dist, 'popup.js'),
    format: 'esm',
    bundle: true,
    target: 'chrome111',
  },
];

const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
  },
};

async function buildManifest() {
  // src/manifest.ts is the typed source of truth (§5.3). Bundle it to a
  // throwaway ESM file, import it for its default export, then write plain
  // JSON — Chrome will not load a manifest with TS syntax.
  const tmpOut = path.join(dist, '.manifest.build.mjs');
  await build({
    entryPoints: [path.join(root, 'src/manifest.ts')],
    outfile: tmpOut,
    format: 'esm',
    bundle: true,
    platform: 'node',
    target: 'node20',
  });
  const mod = await import(`${pathToFileURL(tmpOut).href}?t=${Date.now()}`);
  const manifest = mod.default;
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rm(tmpOut);
  const map = tmpOut + '.map';
  if (existsSync(map)) await rm(map);
}

async function copyStatic() {
  await mkdir(dist, { recursive: true });

  const popupHtmlSrc = path.join(root, 'popup/popup.html');
  if (existsSync(popupHtmlSrc)) {
    await cp(popupHtmlSrc, path.join(dist, 'popup.html'));
  }

  const stylesSrc = path.join(root, 'src/widget/styles');
  if (existsSync(stylesSrc)) {
    await mkdir(path.join(dist, 'styles'), { recursive: true });
    const files = ['tokens.css', 'widget.css', 'animations.css'];
    for (const f of files) {
      const src = path.join(stylesSrc, f);
      if (existsSync(src)) await cp(src, path.join(dist, 'styles', f));
    }
  }

  const popupCssSrc = path.join(root, 'popup/popup.css');
  if (existsSync(popupCssSrc)) {
    await cp(popupCssSrc, path.join(dist, 'popup.css'));
  }

  const iconsSrc = path.join(root, 'icons');
  if (existsSync(iconsSrc)) {
    await cp(iconsSrc, path.join(dist, 'icons'), { recursive: true });
  }
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await copyStatic();
  await buildManifest();

  if (watch) {
    const ctxs = await Promise.all(entries.map((e) => context({ ...common, ...e })));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[build] watching for changes...');
  } else {
    for (const entry of entries) {
      await build({ ...common, ...entry });
    }
    console.log(`[build] done -> ${path.relative(root, dist)}/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
