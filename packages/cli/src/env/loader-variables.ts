/**
 * Environment variables that make a shell or a runtime load or run code (T44): the Bash
 * manual's `PROMPT_COMMAND` and `BASH_ENV`, Node's `NODE_OPTIONS` (`--require`, `--import`),
 * the dynamic loader's `LD_*` and `DYLD_*`, and their kin. A saved value for one of these is
 * a way to run code on another PC, so it is treated like a hook: never added by `--yes` alone.
 */
export const LOADER_VARIABLE =
  /^(PROMPT_COMMAND|BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|LD_.+|DYLD_.+)$/;
