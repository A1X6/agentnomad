/**
 * Builds the npm package `agentnomad` (T40) in `packages/cli/release/`: our own code (cli,
 * core, contracts) bundled into one file with esbuild, and every library it uses left as a
 * normal npm dependency. Run from the repository root:
 *
 *   node --experimental-strip-types packages/cli/scripts/build-release.ts
 *
 * Refuses to finish if anything but our own source ended up in the bundle, or if a library
 * the bundle imports is not declared as a dependency. Ships an npm-shrinkwrap.json (T51).
 */
import { execSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

interface Manifest {
  readonly version: string;
  readonly dependencies?: Record<string, string>;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cliDir = join(root, 'packages', 'cli');
const outDir = join(cliDir, 'release');

const readManifest = async (packageDir: string): Promise<Manifest> =>
  JSON.parse(
    await readFile(join(root, 'packages', packageDir, 'package.json'), 'utf8'),
  ) as Manifest;

/** The libraries the bundle needs at run time: every non-workspace dependency, one version each. */
async function runtimeDependencies(): Promise<Record<string, string>> {
  const dependencies: Record<string, string> = {};
  for (const packageDir of ['cli', 'core', 'contracts']) {
    for (const [name, version] of Object.entries(
      (await readManifest(packageDir)).dependencies ?? {},
    )) {
      if (version.startsWith('workspace:')) continue;
      const known = dependencies[name];
      if (known !== undefined && known !== version) {
        throw new Error(`${name} is ${known} in one package and ${version} in another.`);
      }
      dependencies[name] = version;
    }
  }
  return Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

const { version } = await readManifest('cli');
const dependencies = await runtimeDependencies();

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'dist'), { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/cli/src/bin.ts'],
  outfile: join(outDir, 'dist', 'agentnomad.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  // Our workspace packages are bundled from their TypeScript source.
  conditions: ['agentnomad-source'],
  external: Object.keys(dependencies),
  // Readable output: people can check what they install against the source on GitHub.
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
});

// Only our own source may be inside the bundle; libraries stay npm dependencies.
const bundled = Object.keys(result.metafile.inputs);
const foreign = bundled.filter((input) => !/^packages\/(cli|core|contracts)\/src\//.test(input));
if (foreign.length > 0)
  throw new Error(`Not our own source, bundled anyway:\n${foreign.join('\n')}`);

// Every library the bundle imports must be a declared dependency, or installs would break.
const imported = new Set(
  Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith('node:'))
    .map((entry) => packageOf(entry.path)),
);
const undeclared = [...imported].filter((name) => !(name in dependencies));
if (undeclared.length > 0)
  throw new Error(`Imported but not a dependency: ${undeclared.join(', ')}`);

const manifest = {
  name: 'agentnomad',
  version,
  description:
    'Take your AI coding agent setup (Claude Code first) to any PC: saved encrypted on your PC, restored in one command on macOS, Linux and Windows.',
  keywords: ['claude-code', 'ai-agents', 'agent-setup', 'sync', 'dotfiles', 'encryption', 'cli'],
  homepage: 'https://github.com/A1X6/agent-nomad#readme',
  bugs: { url: 'https://github.com/A1X6/agent-nomad/issues' },
  repository: { type: 'git', url: 'git+https://github.com/A1X6/agent-nomad.git' },
  license: 'MIT',
  author: 'A1X6',
  type: 'module',
  bin: { agentnomad: './dist/agentnomad.js' },
  files: ['dist', 'npm-shrinkwrap.json'],
  engines: { node: '>=22.13' },
  dependencies,
};
await writeFile(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(root, 'README.md'), join(outDir, 'README.md'));
await copyFile(join(root, 'LICENSE'), join(outDir, 'LICENSE'));

// T51: npm-shrinkwrap.json fixes every library version, direct and indirect, so an install
// from npm gets exactly the tree the release run tested. No install scripts run here.
execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', {
  cwd: outDir,
  stdio: 'inherit',
});
execSync('npm shrinkwrap', { cwd: outDir, stdio: 'inherit' });

console.log(
  `agentnomad ${version}: ${String(bundled.length)} source files bundled, ${String(imported.size)} libraries as dependencies → ${outDir}`,
);
