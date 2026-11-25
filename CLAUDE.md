# CLAUDE.md

<!-- Claude Code imports the host-neutral agent guide; keep Claude-specific notes here only. -->
@AGENTS.md

**Agent permissions**

- The committed policy is `.claude/settings.json`. It only allow-lists the
  lint, build, unit and smoke commands plus read-only git/openspec inspection;
  it declares no `ask` or `deny` rules, so agents are not stopped for pushes,
  PRs, e2e runs or file access. The hard rules in `AGENTS.md` still apply.
- Personal overrides belong in the untracked `.claude/settings.local.json`;
  never commit it. It is covered by `.gitignore`.
- Secret scanning runs in CI over every pull-request range and, when
  `gitleaks` is installed, on staged changes through the Husky `pre-commit`
  hook. The hook skips with a warning when the binary is absent.
