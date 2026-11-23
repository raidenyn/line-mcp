# CLAUDE.md

<!-- Claude Code imports the host-neutral agent guide; keep Claude-specific notes here only. -->
@AGENTS.md

**Agent permissions**

- The committed policy is `.claude/settings.json`. It allows the lint, build,
  unit and smoke commands plus read-only git/openspec inspection; asks before
  `git push`, PR merge/create, `docker push`, the live e2e suite and any vitest
  run that targets it; and denies reads of LINE auth/runtime files
  (`.line-auth.json`, `.line-mcp-tokens.json`, `data/`, `.env*`, legacy
  `auth/`, `line-qr.png`), edits under `packages/line-client/assets/ltsm/`,
  `npm publish` and force pushes.
- The `Read`/`Edit` denies bind Claude's built-in file tools (and the Bash file
  commands it recognizes). They are not OS-level isolation; the sandbox issue
  covers that.
- Personal overrides belong in the untracked `.claude/settings.local.json`;
  never commit it. It is covered by `.gitignore`.
- Secret scanning runs in CI over every pull-request range and, when
  `gitleaks` is installed, on staged changes through the Husky `pre-commit`
  hook. The hook skips with a warning when the binary is absent.
