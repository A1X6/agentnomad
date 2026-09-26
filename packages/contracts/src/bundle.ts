import * as z from 'zod';

import { hasControlCharacter } from './primitives.ts';

/**
 * Version of the plaintext bundle format. Bumped only for breaking changes;
 * readers reject any other version (T09).
 */
export const BUNDLE_FORMAT_VERSION = 1;

/** Agent identifier, e.g. `claude-code`. Lowercase letters, digits and dashes. */
export const AgentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'Agent id must be lowercase letters, digits and dashes');

/** An agent's version as it reports it, e.g. `2.1.282` or `2.0.0-beta.3`. */
export const AgentVersionSchema = z
  .string()
  .max(64)
  .regex(/^[0-9A-Za-z.+-]+$/, 'Agent version must be letters, digits, dots, plus or dashes');

/** OS the bundle was pushed from, as reported by Node's `process.platform`. */
export const SourceOsSchema = z.enum(['darwin', 'linux', 'win32']);

/** Bytes `text` takes as UTF-8. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** User-given project name, e.g. `my-saas-app`. Encrypted before it leaves the PC. */
export const ProjectNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((name) => name === name.trim(), 'Project name must not start or end with spaces')
  .refine((name) => !hasControlCharacter(name), 'Project name must not contain control characters')
  // The name is stored NFC-normalised, which can make it longer (T45): the stored form must
  // fit too, so it can always be read back and its encrypted form stays within the API limit.
  .refine((name) => {
    const stored = name.normalize('NFC');
    return stored.length <= 100 && utf8Length(stored) <= 400;
  }, 'Project name is too long');

export const BundleScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('project'), name: ProjectNameSchema }),
]);

/**
 * True when `path` is a relative, forward-slash path that stays inside the agent's
 * base folder on every OS. Guards restore against writing outside that folder.
 */
function isSafeRelativePath(path: string): boolean {
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Path of a file relative to the agent's base folder (global) or project root (project). */
export const BundlePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    isSafeRelativePath,
    'Path must be relative, use forward slashes and stay inside the folder',
  );

const fileFields = { path: BundlePathSchema, executable: z.boolean() };

/**
 * One file in a bundle. Text files are stored as UTF-8 so `{{HOME}}` placeholders can be
 * rewritten per OS; anything else is stored as base64.
 */
export const BundleFileSchema = z.discriminatedUnion('encoding', [
  z.strictObject({ ...fileFields, encoding: z.literal('utf8'), content: z.string() }),
  z.strictObject({ ...fileFields, encoding: z.literal('base64'), content: z.base64() }),
]);

const BundleFilesSchema = z
  .array(BundleFileSchema)
  .max(10_000)
  .superRefine((files, ctx) => {
    const seen = new Set<string>();
    files.forEach((file, index) => {
      if (seen.has(file.path)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate path: ${file.path}`,
          path: [index, 'path'],
        });
      }
      seen.add(file.path);
    });
  });

/**
 * The plaintext bundle for one agent and one scope, before it is compressed and encrypted
 * (T09, T08). Unknown fields are rejected everywhere.
 */
export const BundleSchema = z.strictObject({
  formatVersion: z.literal(BUNDLE_FORMAT_VERSION),
  agent: AgentIdSchema,
  scope: BundleScopeSchema,
  sourceOs: SourceOsSchema,
  /**
   * Version of the agent the setup was saved from, e.g. Claude Code `2.1.282` (T32);
   * `null` when it could not be read. Pull warns when this PC runs an older version.
   */
  agentVersion: AgentVersionSchema.nullable(),
  /**
   * The revision this copy is saved as (T38). It is inside the encryption, so a server
   * cannot pass an older copy off as the current one: pull checks it against the revision
   * the server reports and the one this PC last had.
   */
  revision: z.int().min(1),
  files: BundleFilesSchema,
});

export type AgentId = z.infer<typeof AgentIdSchema>;
export type SourceOs = z.infer<typeof SourceOsSchema>;
export type BundleScope = z.infer<typeof BundleScopeSchema>;
export type BundleFile = z.infer<typeof BundleFileSchema>;
export type Bundle = z.infer<typeof BundleSchema>;
