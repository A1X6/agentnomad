# Contributing

Thanks for helping. This guide covers setting up the project, running it, testing it and
getting a change merged. How the system works is explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Set up

You need [Node.js](https://nodejs.org) 22.13 or newer and pnpm (the version in
`package.json` → `packageManager`; `corepack enable` installs it).

```sh
git clone https://github.com/A1X6/agent-nomad.git
cd agent-nomad
pnpm install
pnpm build
```

Run the CLI you just built:

```sh
node packages/cli/dist/src/bin.js --help
```

## Scripts

| Command                     | What it does                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm build`                | Compiles every package (`tsc --build`).                                                  |
| `pnpm test`                 | All unit and integration tests (Vitest).                                                 |
| `pnpm test:e2e`             | Builds, then runs the built CLI end to end against a local API (three simulated PCs).    |
| `pnpm check`                | Typecheck, lint, format check and tests: what CI runs. Run it before every pull request. |
| `pnpm lint` / `pnpm format` | ESLint / Prettier on their own.                                                          |
| `pnpm release:build`        | Builds the npm package into `packages/cli/release/` (bundled with esbuild).              |

## The repository

| Path                 | What is there                                                           |
| -------------------- | ----------------------------------------------------------------------- |
| `packages/contracts` | Zod schemas for the API and the bundle format, shared by CLI and server |
| `packages/core`      | Crypto, bundle codec, portable paths, merge strategies (pure logic)     |
| `packages/cli`       | The `agentnomad` command and the agent adapters                         |
| `packages/server`    | The API (Hono) and database (Drizzle, Postgres)                         |
| `packages/e2e`       | End-to-end and cross-OS tests                                           |
| `docs/`              | Architecture, roadmap, agent guide, decisions, threat model             |

## Trying it without the hosted API

Everything can run locally. The end-to-end tests start the real API on an in-memory
database (`packages/e2e/src/local-server.ts`); `AGENTNOMAD_API_URL` points the CLI at any
server (plain http is allowed only for `localhost`):

```sh
AGENTNOMAD_API_URL=http://127.0.0.1:3000 node packages/cli/dist/src/bin.js register
```

To run the API itself against Postgres, put `DATABASE_URL` and `SERVER_SECRET`
(`openssl rand -base64 32`) in `packages/server/.env` (never commit it), apply the
migrations with `pnpm --filter @agentnomad/server db:migrate`, then start
`packages/server/dist/src/main.js`.

When testing by hand, use a temporary home folder (set `HOME` and, on Windows,
`USERPROFILE` and `APPDATA`) so your real setup and keychain are never touched.

## How we write code

- **TypeScript strict,** ES modules, no `any`, no unchecked casts.
- **Validate every boundary** with the Zod schemas in `contracts` (API bodies and headers,
  files read back from disk).
- **Small, focused modules with injected dependencies.** Composition roots
  (`packages/cli/src/app.ts`, `packages/server/src/server.ts`) build the real services; the
  rest receives them, so tests need no network, terminal or keychain.
- **Agent-specific code stays in its adapter** (`packages/cli/src/agents/<agent>/`). See
  [docs/ADDING-AN-AGENT.md](docs/ADDING-AN-AGENT.md).
- **Formats are versioned and never changed in place** (bundle format, key labels, hash
  prefixes): add a new version next to the old one.
- **Check a library's documentation for the version we pin** before using it.
- **New dependencies are discussed first** in an issue: we prefer the platform and the
  libraries already in use, and a security tool should have few dependencies.
- **Comments explain why,** in plain English; code says what.

## Tests

- Every change comes with tests: a failing test first for a bug, tests for each new
  behaviour and its edge cases.
- Tests use temporary folders and fakes. They must never read or write the real home
  folder, the real keychain or the hosted API.
- Anything that touches paths runs on macOS, Linux and Windows in CI; write it so it passes
  on all three (use `path.join`, never assume `/`).
- A change to push, pull or the bundle belongs in the end-to-end steps too
  (`packages/e2e/src/steps.ts`), including the check that nothing readable leaves the PC
  (`packages/e2e/src/plaintext.ts`: as text, encoded or compressed).

## Pull requests

1. Fork, and create a branch from `dev`.
2. Make the change with its tests and docs (README, [docs/](docs/)).
3. `pnpm check` and `pnpm test:e2e` pass.
4. Open the pull request against `dev`, describing what and why. CI must be green on every
   OS.

`dev` is released to `main` when a set of changes is ready.

## Keeping up with Claude Code

Every Monday, `.github/workflows/drift-check.yml` compares the Claude Code paths data file
(`packages/cli/src/agents/claude-code/claude-code-paths.data.ts`) with the newest Claude Code
and, when something needs a look, opens or updates an issue labelled `drift`. To handle it:
sort each new name into `neverSynced`, `knownState` or a synced list (never sync credentials,
history, caches or machine state), read the listed changelog entries, set `reviewedVersion`
to the version in the issue, and run `pnpm check`. Run the check locally with
`node --experimental-strip-types packages/cli/scripts/drift/check-claude-code.ts`.

## Releases

Maintainers release from `main`:

1. Set the new version in `packages/cli/package.json` and `packages/cli/src/version.ts`
   (a test keeps them equal), merged through `dev` to `main`.
2. Tag the commit on `main` (`git tag v1.2.3 && git push origin v1.2.3`).
3. `.github/workflows/release.yml` builds and tests the package on every OS, then waits for
   approval in the `npm` environment; after approval it publishes with provenance through
   npm trusted publishing and checks `npx agentnomad` on every OS.

To try the package locally: `pnpm release:build`, then
`npm pack ./packages/cli/release` and install the `.tgz` into a temporary prefix
(`npm install -g --prefix <temp folder> ./agentnomad-*.tgz`).

## Security

Never put secrets in code, tests, commits or issues. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
