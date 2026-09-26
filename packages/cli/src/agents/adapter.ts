import type { AgentId, SourceOs } from '@agentnomad/contracts';

import type { Prompter, Reporter } from '../ui/prompter.ts';

/** Where a setup lives on this PC: the agent's global folder, or one project folder. */
export type ScopeTarget =
  { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectDir: string };

/** What a Detector found on this PC. */
export interface DetectedAgent {
  readonly installed: boolean;
  /** Absolute base folder, e.g. `~/.claude` or `CLAUDE_CONFIG_DIR`; `null` when not installed. */
  readonly baseDir: string | null;
  /** Agent version, e.g. from `claude --version`; `null` when unknown. */
  readonly version: string | null;
}

/** Is the agent installed here, and where is its base folder (T24)? */
export interface Detector {
  detect(): Promise<DetectedAgent>;
}

/** A file read from disk, ready to go into a bundle. */
export interface CollectedFile {
  /** Bundle path: relative to the base folder (global) or project root (project). */
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface CollectOptions {
  /** Include opt-in memory folders (subagent and auto memory). */
  readonly includeMemory: boolean;
  /**
   * Include a copy of the user's own skills that the agent's online account syncs to this PC
   * (T42: Claude Code's claude.ai skills). Opt-in; global setup only.
   */
  readonly includeAccountSkills?: boolean;
  /** Told about each file left out, with why (T45: a link to a refused place, a huge file). */
  readonly onSkipped?: (bundlePath: string, reason: string) => void;
}

/** Which files belong to a setup. Never collects credentials or machine state (T25, T26). */
export interface Collector {
  collect(target: ScopeTarget, options: CollectOptions): Promise<readonly CollectedFile[]>;
}

/** The user's answer when a pulled file already exists here. */
export type ConflictChoice = 'merge' | 'overwrite' | 'skip';

export interface ConflictQuestion {
  /**
   * False for a file that must never be replaced, e.g. `~/.claude.json`, which also holds
   * the Claude login: then only merge or skip may be offered.
   */
  readonly overwriteAllowed: boolean;
}

/** Asks (or decides from flags) what to do with one existing file that differs. */
export type ConflictResolver = (
  path: string,
  question: ConflictQuestion,
) => Promise<ConflictChoice>;

/** What a restore did, for the summary shown to the user. Paths are bundle paths. */
export interface RestoreReport {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  /** Backups made before overwriting. */
  readonly backups: readonly string[];
  /** Things the user should know, e.g. a hook that will likely not run on this OS. */
  readonly warnings: readonly string[];
}

/** About the setup being restored. */
export interface RestoreContext {
  /** OS the setup was pushed from, to flag hooks that only run there. */
  readonly sourceOs?: SourceOs;
  /** `--yes`: take the safe answer instead of asking (e.g. skip a file an open app rewrites). */
  readonly assumeYes?: boolean;
}

/** Writes a pulled setup to disk, with per-OS permissions and line endings (T27). */
export interface Restorer {
  restore(
    target: ScopeTarget,
    files: readonly CollectedFile[],
    onConflict: ConflictResolver,
    context?: RestoreContext,
  ): Promise<RestoreReport>;
}

/** Agent-specific checks that commands show to the user (T31, T32). */
export interface AgentInspector {
  /** Entries the collector does not know, e.g. a folder a newer agent version added. */
  unknownEntries(target: ScopeTarget): Promise<readonly string[]>;
  /** Things to point out before push or pull, e.g. organization-managed settings. */
  notices(command: 'push' | 'pull'): Promise<readonly string[]>;
  /**
   * The user's own skills the agent's online account syncs to this PC, which push can save
   * a copy of (T42), or why they cannot be read.
   */
  accountSkills?(): Promise<{ readonly names: readonly string[]; readonly problem: string | null }>;
}

/** What an agent's follow-up after a restore gets (T34), e.g. to reinstall plugins. */
export interface AfterRestoreContext {
  readonly target: ScopeTarget;
  /** The restored setup's files, including agentnomad's own entries (plugins, programs). */
  readonly files: readonly CollectedFile[];
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  /** `--yes`: accept without asking where that is safe. */
  readonly assumeYes: boolean;
  /**
   * `--allow-commands`: also accept what installs or runs code (plugins, programs) without
   * asking. Without it, `--yes` skips those with a note (T38).
   */
  readonly allowCommands: boolean;
  /**
   * `--account-skills` / `--no-account-skills`: add saved account skills as local skills, or
   * not, without asking (T42). `undefined` asks (`--yes` alone: no).
   */
  readonly accountSkills?: boolean;
}

/**
 * Everything agentnomad knows about one agent. Adding an agent means writing one of these
 * and registering it; nothing else changes.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  /** Shown to users, e.g. `Claude Code`. */
  readonly displayName: string;
  readonly detector: Detector;
  readonly collector: Collector;
  readonly restorer: Restorer;
  readonly inspector?: AgentInspector;
  /** Runs after a pull restored a setup, e.g. plugin reinstalls (T34). */
  readonly afterRestore?: (context: AfterRestoreContext) => Promise<void>;
}

/** The only place agents are registered (T28). */
export interface AgentRegistry {
  list(): readonly AgentAdapter[];
  get(id: AgentId): AgentAdapter | undefined;
}
