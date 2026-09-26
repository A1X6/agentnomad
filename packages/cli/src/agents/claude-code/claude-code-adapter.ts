import type { AgentAdapter, Collector } from '../adapter.ts';
import { readSyncedSkills } from './account-skills.ts';
import { createClaudeCodeAfterRestore } from './after-restore.ts';
import { claudeConfigDir, createClaudeCodeDetector, nodeDetectorSystem } from './detector.ts';
import { createFileGatherer } from './file-gathering.ts';
import { createClaudeCodeGlobalCollector } from './global-collector.ts';
import {
  detectManagedSettings,
  managedSettingsNotice,
  nodeManagedSettingsSystem,
} from './managed-settings.ts';
import { createProgramLocator } from './programs.ts';
import { createClaudeCodeProjectCollector } from './project-collector.ts';
import { createClaudeCodeRestorer, type ClaudeRunningAnswer } from './restorer.ts';
import { createClaudeRunningCheck, type ClaudeRunningCheck } from './running-claude.ts';
import { findUnknownEntries } from './unknown-files.ts';

export interface ClaudeCodeAdapterOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Asks the user to close Claude Code (retry) or leave `~/.claude.json` alone (skip). */
  readonly onClaudeRunning: () => Promise<ClaudeRunningAnswer>;
  /** Defaults to the real process list. */
  readonly isClaudeRunning?: ClaudeRunningCheck;
}

/**
 * The Claude Code adapter (T28): the detector (T24), the global and project collectors
 * (T25, T26) and the restorer (T27) for this PC, behind the AgentAdapter interface.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): AgentAdapter {
  const system = nodeDetectorSystem(options.env, options.homedir, options.platform);
  const baseDir = claudeConfigDir(system);
  const customConfigDir = (options.env['CLAUDE_CONFIG_DIR']?.trim() ?? '') !== '';
  const shared = { baseDir, homedir: options.homedir, platform: options.platform };

  const global = createClaudeCodeGlobalCollector({
    ...shared,
    customConfigDir,
    findProgram: createProgramLocator(system),
  });
  const project = createClaudeCodeProjectCollector({ ...shared, env: options.env });
  const collector: Collector = {
    collect: (target, collectOptions) =>
      (target.kind === 'global' ? global : project).collect(target, collectOptions),
  };

  const restorer = createClaudeCodeRestorer({
    ...shared,
    env: options.env,
    customConfigDir,
    isClaudeRunning: options.isClaudeRunning ?? createClaudeRunningCheck(),
    onClaudeRunning: options.onClaudeRunning,
  });

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    detector: createClaudeCodeDetector(system),
    collector,
    restorer,
    afterRestore: createClaudeCodeAfterRestore({ system, restorer }),
    inspector: {
      unknownEntries: (target) =>
        findUnknownEntries(target, {
          baseDir,
          platform: options.platform,
          homedir: options.homedir,
        }),
      async notices(command) {
        const found = await detectManagedSettings(
          nodeManagedSettingsSystem(options.env, baseDir, options.platform),
        );
        const notice = managedSettingsNotice(found, command);
        return notice === null ? [] : [notice];
      },
      async accountSkills() {
        const synced = await readSyncedSkills(createFileGatherer(options.platform), baseDir);
        return { names: synced.own.map((skill) => skill.name), problem: synced.problem };
      },
    },
  };
}
