/**
 * What in a skill, command or subagent file Claude Code runs by itself (T44), per its skills
 * and hooks docs: a `` !`command` `` placeholder at the start of a line or after whitespace,
 * a ` ```! ` block, and `hooks` in the frontmatter. These run without Claude choosing to (the
 * placeholders before Claude even sees the skill). Commands written as instructions (plain
 * text or code blocks without the `!` forms) never run by themselves and are not reported.
 */
export function runnableInMarkdown(text: string): string[] {
  const found: string[] = [];
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (frontmatter?.[1] !== undefined && /^hooks\s*:/m.test(frontmatter[1])) {
    found.push('hooks in its frontmatter');
  }
  let inFence: 'plain' | 'command' | null = null;
  const block: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (inFence === null && fence) {
      inFence = fence[2]?.trim() === '!' ? 'command' : 'plain';
      continue;
    }
    if (inFence !== null && fence && (fence[2] ?? '').trim() === '') {
      if (inFence === 'command') found.push(`! block: ${block.join('; ')}`);
      block.length = 0;
      inFence = null;
      continue;
    }
    if (inFence === 'command') {
      if (line.trim() !== '') block.push(line.trim());
      continue;
    }
    // The docs exempt no part of the file, so a placeholder inside an ordinary code block
    // counts too.
    for (const match of line.matchAll(/(?:^|\s)!`([^`\n]+)`/g)) {
      found.push(`!\`${match[1] ?? ''}\``);
    }
  }
  if (inFence === 'command' && block.length > 0) found.push(`! block: ${block.join('; ')}`);
  return found;
}
