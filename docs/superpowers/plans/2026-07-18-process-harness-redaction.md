# Process Harness Credential Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent escaped and truncated quoted LINE credentials from leaking through smoke-test child-process readiness diagnostics.

**Architecture:** Add a small scanner around recognized quoted credential prefixes instead of trying to parse arbitrary malformed JSON with regular expressions. Keep the change inside the existing process harness and verify it exclusively through the public `spawnManagedNode` readiness-error path.

**Tech Stack:** TypeScript, Node.js child processes, Vitest, ESLint

## Global Constraints

- Work on `fix/process-harness-redaction`, created from `origin/main`.
- Cover `accessToken`, `refreshToken`, `certificate`, `wrappedNonce`, `kdfParameter1`, and `kdfParameter2` case-insensitively.
- Support double-quoted and single-quoted key/value forms.
- Preserve safe diagnostics after a newline; an unterminated credential consumes the rest of its own line.
- Do not change header, assignment, JWT-like token, MID, or production credential handling.
- Do not expose complete secret sentinels when a regression assertion fails.

---

### Task 1: Escape-Aware Quoted Credential Redaction

**Files:**
- Modify: `tests/smoke/process-harness.test.ts:262-300`
- Modify: `tests/support/process-harness.ts:15-63`

**Interfaces:**
- Consumes: `spawnManagedNode(options: SpawnOptions): Promise<ManagedProcess>` and its existing readiness-error diagnostics.
- Produces: Internal `redactQuotedCredentials(value: string): string`, called by `redact(value: string): string`; no exported API changes.

- [ ] **Step 1: Replace the existing complete-JSON regression with escaped and truncated readiness-error cases**

Keep the test on the real child-process path. Generate complete fixtures for every key and both quote styles, include escaped quotes and backslashes, then append newline-terminated and output-end truncated fixtures. Use a custom assertion that reports only fixture metadata if a sentinel survives:

```typescript
  it('redacts escaped and truncated quoted credentials from child output', async () => {
    const credentialKeys = [
      'accessToken', 'refreshToken', 'certificate',
      'wrappedNonce', 'kdfParameter1', 'kdfParameter2',
    ];
    const secrets: Array<{ key: string; form: string; value: string }> = [];
    const output: string[] = [];

    for (const key of credentialKeys) {
      const doubleValue = [`double`, key, `probe`, `742`].join('_');
      const singleValue = [`single`, key, `probe`, `742`].join('_');
      secrets.push(
        { key, form: 'double', value: doubleValue },
        { key, form: 'single', value: singleValue },
      );
      output.push(`{"${key}":"prefix\\\"${doubleValue}\\\\suffix"}`);
      output.push(`{'${key}':'prefix\\'${singleValue}\\\\suffix'}`);
    }

    const lineTruncated = ['line', 'access', 'probe', '742'].join('_');
    const endTruncated = ['end', 'refresh', 'probe', '742'].join('_');
    secrets.push(
      { key: 'accessToken', form: 'line-truncated', value: lineTruncated },
      { key: 'refreshToken', form: 'end-truncated', value: endTruncated },
    );
    output.push(`{"accessToken":"${lineTruncated}\nSAFE_NEXT_LINE`);
    output.push(`{'refreshToken':'${endTruncated}`);

    let thrown: Error | null = null;
    try {
      await spawnManagedNode({
        label: 'json-credential-redaction-fixture', cwd: projectRoot,
        args: ['-e', `process.stderr.write(${JSON.stringify(output.join('\n'))}); setInterval(() => {}, 1000); process.stdout.write('not-ready\\n')`],
        readyLine: line => line === 'ready',
        readyTimeoutMs: 500,
      });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toMatch(/readiness timeout after 500ms/);
    for (const secret of secrets) {
      if (thrown!.message.includes(secret.value)) {
        throw new Error(`credential sentinel leaked for ${secret.key} (${secret.form})`);
      }
    }
    expect(thrown!.message).toContain('SAFE_NEXT_LINE');
    expect(thrown!.message.match(/<redacted>/g)?.length).toBe(secrets.length);
  });
```

- [ ] **Step 2: Run the focused test and confirm the security regression**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts -t "redacts escaped and truncated quoted credentials"
```

Expected: FAIL with `credential sentinel leaked` for an escaped or truncated fixture. The failure must identify only the key and fixture form, not the secret value.

- [ ] **Step 3: Add the minimal escape-aware scanner and remove the 12 quoted-value regex replacements**

Add this helper above `redact()`, then call it as the first operation in `redact`:

```typescript
const QUOTED_CREDENTIAL_PREFIX = /(["'])(accessToken|refreshToken|certificate|wrappedNonce|kdfParameter1|kdfParameter2)\1(\s*:\s*)(["'])/gi;

function redactQuotedCredentials(value: string): string {
  let result = '';
  let copiedThrough = 0;
  let match: RegExpExecArray | null;

  QUOTED_CREDENTIAL_PREFIX.lastIndex = 0;
  while ((match = QUOTED_CREDENTIAL_PREFIX.exec(value)) !== null) {
    const valueQuote = match[4];
    let cursor = QUOTED_CREDENTIAL_PREFIX.lastIndex;

    result += value.slice(copiedThrough, cursor) + '<redacted>';
    while (cursor < value.length && value[cursor] !== '\r' && value[cursor] !== '\n') {
      if (value[cursor] === '\\' && cursor + 1 < value.length
          && value[cursor + 1] !== '\r' && value[cursor + 1] !== '\n') {
        cursor += 2;
        continue;
      }
      if (value[cursor] === valueQuote) {
        result += valueQuote;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    copiedThrough = cursor;
    QUOTED_CREDENTIAL_PREFIX.lastIndex = cursor;
  }

  return result + value.slice(copiedThrough);
}

function redact(value: string): string {
  return redactQuotedCredentials(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
    // Keep the remaining existing replacement chain unchanged.
}
```

Delete the existing replacements and comments at `tests/support/process-harness.ts:42-57`. The scanner preserves the original key spelling, whitespace, colon, opening quote, and a closing quote when one exists.

- [ ] **Step 4: Run the focused process-harness suite**

Run:

```bash
npx vitest run tests/smoke/process-harness.test.ts
```

Expected: PASS for the full file, including existing assignment, header, JWT, process cleanup, and new quoted-credential coverage.

- [ ] **Step 5: Run all required verification gates**

Run:

```bash
npm run test:smoke
npm run lint
```

Expected: both commands exit with status 0. Smoke output reports all smoke test files passing; lint reports no errors.

- [ ] **Step 6: Inspect the final diff for scope and accidental secret literals**

Run:

```bash
git diff --check
```

Expected: no whitespace errors; changes are limited to the scanner, regression test, design, and plan on `fix/process-harness-redaction`.
