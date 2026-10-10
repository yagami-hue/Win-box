// Upload installers only to an existing Release. Never include blockmap/build metadata.
// Usage: pnpm run release:upload [-- --dry-run]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => a !== '--');
if (args.some(a => a !== '--dry-run')) {
  console.error('Usage: node scripts/upload-release.mjs [--dry-run]');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `release${pkg.version}`;
const repo = 'yagami-hue/Win-box';
const output = resolve(root, pkg.build.directories.output);
const assets = readdirSync(output, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.exe') &&
    (e.name === `Win-Box Setup ${pkg.version}.exe` || e.name === `Win-Box ${pkg.version}.exe`))
  .map(e => join(output, e.name));
if (!assets.length) {
  console.error(`No installers for ${pkg.version} found in ${output}`);
  process.exit(1);
}
console.log(`Release: ${repo} / ${tag}`);
for (const asset of assets) console.log(`Installer: ${asset}`);
if (args.includes('--dry-run')) {
  console.log('Dry run: no files uploaded. Only .exe installers are selected.');
} else {
  const run = commandArgs => {
    const result = spawnSync('gh', commandArgs, { cwd: root, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  // Does not create a Release, replace existing assets, or edit release notes.
  run(['release', 'view', tag, '--repo', repo]);
  run(['release', 'upload', tag, ...assets, '--repo', repo]);
}
