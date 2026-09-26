import { readdir, readFile, stat } from 'node:fs/promises';

import * as z from 'zod';

import type { CollectedFile } from '../adapter.ts';
import type { FileGatherer } from './file-gathering.ts';
import { RESERVED_DIR } from './global-paths.ts';
import { runnableInMarkdown } from './runnable-markdown.ts';

/**
 * Skills from the user's claude.ai account (T42). Claude Code downloads them into
 * `~/.claude/skills/synced/<account>/<name>/` and manages that folder itself; agentnomad
 * never writes there. On request, push saves the user's **own** ones (never Anthropic's or
 * an organization's) under a reserved bundle folder, and pull can add them back as normal
 * local skills on a PC that does not get them from its own claude.ai sync.
 */
export const SYNCED_SKILLS_DIR = 'skills/synced';
export const ACCOUNT_SKILLS_PREFIX = `${RESERVED_DIR}/account-skills/`;

/**
 * Claude Code's `manifest.json` for one account's synced skills (an internal file, so only
 * the fields used here are checked, and each entry on its own). `creatorType` is `user` for
 * skills the user made, `anthropic` for Anthropic's; anything else, including an entry
 * without it (seen on a newly synced skill), is never saved.
 */
const ManifestSchema = z.looseObject({ skills: z.array(z.unknown()) });
const EntrySchema = z.looseObject({ name: z.string(), creatorType: z.string().optional() });

/** A skill folder name that is safe everywhere and not one Claude Code reserves. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RESERVED_NAMES = new Set(['synced', 'anthropic-skills']);
export const isUsableSkillName = (name: string) =>
  SKILL_NAME.test(name) &&
  !RESERVED_NAMES.has(name.toLowerCase()) &&
  !name.toLowerCase().startsWith('anthropic-skills:');

export interface SyncedSkills {
  /** The user's own skills, with their folder on this PC. */
  readonly own: readonly { readonly name: string; readonly dir: string }[];
  /** Every synced skill name on this PC (any creator), to avoid adding a duplicate. */
  readonly allNames: ReadonlySet<string>;
  /** Why nothing could be read, e.g. a manifest in an unknown format; `null` when fine. */
  readonly problem: string | null;
}

const isDirectory = async (path: string) =>
  (await stat(path).catch(() => null))?.isDirectory() ?? false;

/** What `~/.claude/skills/synced/` holds on this PC. Never throws; unreadable parts are skipped. */
export async function readSyncedSkills(
  files: FileGatherer,
  baseDir: string,
): Promise<SyncedSkills> {
  const { path } = files;
  const root = path.join(baseDir, ...SYNCED_SKILLS_DIR.split('/'));
  const own = new Map<string, string>();
  const allNames = new Set<string>();
  let problem: string | null = null;
  const accounts = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const account of accounts) {
    if (!account.isDirectory() || account.name.startsWith('.')) continue;
    const accountDir = path.join(root, account.name);
    const text = await readFile(path.join(accountDir, 'manifest.json'), 'utf8').catch(() => null);
    let manifest: z.infer<typeof ManifestSchema> | null = null;
    if (text !== null) {
      try {
        const parsed = ManifestSchema.safeParse(JSON.parse(text));
        if (parsed.success) manifest = parsed.data;
      } catch {
        // Treated like an unknown format below.
      }
    }
    if (manifest === null) {
      problem = `Claude Code's list of synced skills (${SYNCED_SKILLS_DIR}/${account.name}/manifest.json) is missing or in a format agentnomad does not know.`;
      continue;
    }
    for (const entry of manifest.skills) {
      const parsed = EntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      const skill = parsed.data;
      allNames.add(skill.name.toLowerCase());
      const dir = path.join(accountDir, skill.name);
      if (
        skill.creatorType === 'user' &&
        isUsableSkillName(skill.name) &&
        !own.has(skill.name) &&
        (await isDirectory(dir))
      ) {
        own.set(skill.name, dir);
      }
    }
  }
  return {
    own: [...own.entries()]
      .map(([name, dir]) => ({ name, dir }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    allNames,
    problem,
  };
}

/** The user's own synced skills as bundle files, under `.agentnomad/account-skills/<name>/`. */
export async function collectAccountSkills(
  files: FileGatherer,
  skills: SyncedSkills,
): Promise<CollectedFile[]> {
  const found: CollectedFile[] = [];
  for (const skill of skills.own) {
    found.push(
      ...(await files.walk(skill.dir, `${ACCOUNT_SKILLS_PREFIX}${skill.name}`, () => false)),
    );
  }
  return found;
}

export interface AccountSkillPlan {
  /** Skills that can be added here, and whether each runs commands as a local skill. */
  readonly toAdd: readonly { readonly name: string; readonly runsCommands: boolean }[];
  /** Skills left out, with why. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  /** The files to write, as global bundle paths (`skills/<name>/...`). */
  readonly files: readonly CollectedFile[];
}

/**
 * Which saved account skills pull may add on this PC as local skills: not one this PC already
 * gets from its own claude.ai sync, and never over a local skill of the same name.
 */
export function planAccountSkills(
  bundleFiles: readonly CollectedFile[],
  here: { syncedNames: ReadonlySet<string>; localNames: ReadonlySet<string> },
): AccountSkillPlan {
  const byName = new Map<string, CollectedFile[]>();
  for (const file of bundleFiles) {
    if (!file.path.startsWith(ACCOUNT_SKILLS_PREFIX)) continue;
    const rest = file.path.slice(ACCOUNT_SKILLS_PREFIX.length);
    const name = rest.split('/')[0] ?? '';
    if (!isUsableSkillName(name) || rest === name) continue;
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const toAdd: { name: string; runsCommands: boolean }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const files: CollectedFile[] = [];
  for (const [name, skillFiles] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (here.syncedNames.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'this PC already gets it from claude.ai' });
      continue;
    }
    if (here.localNames.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'you already have a local skill with this name' });
      continue;
    }
    const runsCommands = skillFiles.some(
      (file) =>
        file.path.toLowerCase().endsWith('.md') &&
        runnableInMarkdown(new TextDecoder().decode(file.content)).length > 0,
    );
    toAdd.push({ name, runsCommands });
    for (const file of skillFiles) {
      files.push({ ...file, path: `skills/${file.path.slice(ACCOUNT_SKILLS_PREFIX.length)}` });
    }
  }
  return { toAdd, skipped, files };
}
