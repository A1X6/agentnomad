# Security

agentnomad handles people's agent setups, which can include API keys and scripts that run
on their machines. Security reports are taken seriously and handled first.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/A1X6/agent-nomad/security/advisories/new).

Please include what an attacker could do, the steps to reproduce it, and the version
(`agentnomad --version`). You can expect a first answer within 7 days. We will keep you
updated, agree on a disclosure date with you, and credit you in the advisory unless you
prefer otherwise.

In scope: the `agentnomad` CLI, the hosted API, the bundle and key formats, and this
repository's build and release. Out of scope: attacks that need the user's password or an
already compromised PC, and denial of service by volume.

## Supported versions

| Version            | Supported         |
| ------------------ | ----------------- |
| Latest 1.x release | Yes               |
| Older releases     | No: please update |

## How agentnomad protects your data

- **Encrypted on your PC.** A random 256-bit data key encrypts every saved setup with
  XChaCha20-Poly1305. The data key is itself encrypted ("wrapped") with a key derived from
  your password with Argon2id (64 MiB, 3 passes). The server only ever stores ciphertext.
- **Your password never leaves your PC.** The server receives an auth key, a separate key
  derived from the same password, and stores only a keyed hash of it (HMAC-SHA256 with a
  secret held outside the database). A stolen database alone cannot be used to test
  password guesses.
- **Hidden project names.** The server sees a keyed hash and an encrypted name, never the
  project's name.
- **Bound bundles.** Each bundle is bound to its agent, scope and format, and carries its
  revision inside the encryption, so a server cannot swap one setup for another or pass an
  older copy off as the latest.
- **Nothing runs unseen.** Pull lists everything new or changed that Claude Code would run
  before writing it: hooks, status line commands, settings that run a command (such as
  `apiKeyHelper`), MCP servers (their whole definition), the scripts they run, and skills,
  commands or subagents with commands that run by themselves. It only restores files outside
  the agent's folder that its own hooks run, never into a Startup, autostart or shell-profile
  folder. `--yes` alone never accepts new commands, installs, or environment values that make
  programs load code; `--allow-commands` does.
- **Local secrets in the OS keychain,** or in a file only your user can read where there is
  no keychain (on Windows with an access list for your user only).
- **Limits on the server.** Each account keeps at most 100 setups and 50 MB, with limits on
  saves, logins and account deletes, so one account cannot fill the service or guess passwords
  quickly.
- **Checked on every change.** Automated tests on macOS, Linux and Windows record every
  request the CLI makes and fail if anything readable (a password, the data key, file
  contents, a project name) is in it, also inside compressed or encoded data.

**What the server can see:** your username, the device name (the PC's host name) of each
login, and for each saved setup its agent, size, revision and times. **There is no password
recovery:** forgetting your password makes your saved setups unreadable for everyone.

The full analysis, including every defence, how it is tested and the risks we accept, is
the [threat model](docs/security/threat-model.md). How the keys fit together is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#3-keys-and-encryption).
