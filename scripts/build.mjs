import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** Static files are copied rather than bundled so the HTML stays readable. */
function copyStaticAssets() {
  const from = path.join(root, 'src/renderer');
  const to = path.join(outdir, 'renderer');
  fs.mkdirSync(to, { recursive: true });

  for (const file of fs.readdirSync(from)) {
    if (file.endsWith('.html') || file.endsWith('.css')) {
      fs.copyFileSync(path.join(from, file), path.join(to, file));
    }
  }
}

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

const builds = [
  {
    ...shared,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(outdir, 'main/index.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Electron and the HID native addon are resolved at runtime, not bundled.
    external: ['electron', 'node-hid'],
  },
  {
    ...shared,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(outdir, 'preload/index.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    ...shared,
    entryPoints: [
      path.join(root, 'src/renderer/overlay.ts'),
      path.join(root, 'src/renderer/settings.ts'),
    ],
    outdir: path.join(outdir, 'renderer'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome128',
  },
];

if (watch) {
  copyStaticAssets();
  const contexts = await Promise.all(builds.map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));

  fs.watch(path.join(root, 'src/renderer'), (_event, file) => {
    if (file && (file.endsWith('.html') || file.endsWith('.css'))) copyStaticAssets();
  });

  console.log('Watching for changes. Run "npx electron ." in another terminal.');
} else {
  await Promise.all(builds.map((config) => esbuild.build(config)));
  copyStaticAssets();
  console.log('Build complete.');
}
