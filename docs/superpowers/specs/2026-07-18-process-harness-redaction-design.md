# Process Harness Credential Redaction Design

## Context

The smoke-test process harness includes captured child output in readiness-error diagnostics. Its current regular expressions redact complete quoted credential values, but terminate at escaped quotes and do not match values whose closing quote was truncated. This can expose LINE credentials in local or CI logs.

The affected keys are `accessToken`, `refreshToken`, `certificate`, `wrappedNonce`, `kdfParameter1`, and `kdfParameter2`.

## Scope

Harden quoted credential redaction in `tests/support/process-harness.ts` and add regression coverage in `tests/smoke/process-harness.test.ts`. Existing redaction for headers, assignment forms, JWT-like values, and MIDs remains unchanged.

## Design

Replace the repeated double- and single-quoted credential regular expressions with one focused quoted-value redaction helper.

The helper will:

- Recognize all six credential keys in double-quoted and single-quoted forms, case-insensitively.
- Preserve the matched key, whitespace, separator, and quote style.
- Scan the value one character at a time so an escaped quote does not terminate it.
- Treat a backslash and its following character as one escaped sequence.
- Replace a complete value with `<redacted>` while preserving its closing quote.
- If no unescaped closing quote exists, redact through the first carriage return, newline, or captured-output end.

For malformed input, confidentiality takes priority over preserving text on the same line. A truncated credential therefore consumes the rest of that diagnostic line, while subsequent lines remain available for troubleshooting.

## Testing

Regression tests will exercise `spawnManagedNode` through its real readiness-timeout rejection path rather than calling the helper directly.

Table-driven fixtures will cover:

- Every affected credential key.
- Double-quoted and single-quoted values.
- Escaped quotes and escaped backslashes in complete values.
- Unterminated values ending at a newline and at captured-output end.
- Preservation of diagnostic text on the line after a truncated value.

Assertions will verify redaction markers and safe surrounding diagnostics. Secret probes will be assembled from fragments, and assertions will check those fragments independently so a failed assertion does not print a complete raw sentinel value.

## Verification

Run the focused process-harness test, then the required gates:

```bash
npx vitest run tests/smoke/process-harness.test.ts
npm run test:smoke
npm run lint
```

## Out Of Scope

- Changing production credential handling.
- Parsing arbitrary JSON or JavaScript object literals.
- Refactoring unrelated process lifecycle or cleanup behavior.
