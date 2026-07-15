# OAuth Authorize Page XSS Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent OAuth `state` and `redirect_uri` values from breaking out of the authorization page script context.

**Architecture:** Put authorization-page values in a non-executable JSON script element and parse them from the executable polling script. Escape `<` in the serialized JSON as `\u003c` before it is embedded, which prevents a literal `</script>` terminator while preserving the values passed to redirect handling.

**Tech Stack:** TypeScript, Express, Vitest

## Global Constraints

- Preserve OAuth validation, QR polling, PIN display, and redirect behavior.
- Do not interpolate OAuth-controlled values directly into executable JavaScript.
- Escape `<` in the embedded JSON so `</script>` cannot terminate the data element.
- Limit changes to authorization-page serialization and its tests.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/oauth.ts` | Modify | Render and consume safe serialized authorization-page context |
| `src/oauth.test.ts` | Modify | Verify script-breakout payloads remain inert and context is recoverable |

---

### Task 1: Serialize Authorize Context Safely

**Files:**
- Modify: `src/oauth.ts:413-447`
- Modify: `src/oauth.test.ts:206-267`

**Interfaces:**
- Consumes: `authorizePageHtml(qrDataUrl, sid, state, redirectUri, basePath)`.
- Produces: an `oauth-context` JSON script element and executable polling code that reads `{ sid, state, redirectUri, basePath }` from it.

- [ ] **Step 1: Add a failing authorize-page injection regression test**

In `src/oauth.test.ts`, add this test inside `describe('GET /authorize')`:

```typescript
it('keeps script-breakout OAuth values in inert JSON context', async () => {
  const state = '</script><img src=x onerror=alert(1)>';
  const redirectUri = 'http://localhost:8765/</script><img src=x onerror=alert(2)>';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'claude-code',
    redirect_uri: redirectUri,
    code_challenge: s256('verifier123'),
    code_challenge_method: 'S256',
    state,
  });

  const { status, body } = await req(`${base}/authorize?${params}`);
  const html = body as string;
  const context = html.match(/<script type="application\/json" id="oauth-context">([\s\S]*?)<\/script>/)?.[1];

  expect(status).toBe(200);
  expect(html).not.toContain('</script><img');
  expect(context).toBeDefined();
  expect(JSON.parse(context!)).toMatchObject({ state, redirectUri, basePath: '' });
});
```

- [ ] **Step 2: Run the focused test to verify the red state**

Run: `npx vitest run src/oauth.test.ts -t "script-breakout OAuth values"`

Expected: FAIL because `authorizePageHtml` currently includes the literal `</script><img` sequence inside executable script interpolation and does not emit `oauth-context`.

- [ ] **Step 3: Replace executable interpolation with escaped JSON context**

In `authorizePageHtml`, before the returned template, add:

```typescript
const oauthContext = JSON.stringify({ sid, state, redirectUri, basePath })
  .replace(/</g, '\\u003c');
```

Replace the four executable declarations:

```html
<script>
const sid = ...;
const state = ...;
const redirectUri = ...;
const basePath = ...;
```

with:

```html
<script type="application/json" id="oauth-context">${oauthContext}</script>
<script>
const { sid, state, redirectUri, basePath } = JSON.parse(
  document.getElementById('oauth-context').textContent,
);
```

Keep the existing `poll()` implementation unchanged after these declarations.

- [ ] **Step 4: Run the focused test to verify green**

Run: `npx vitest run src/oauth.test.ts -t "script-breakout OAuth values"`

Expected: PASS. The HTML contains `\u003c/script>` rather than a literal closing-script payload and parsing the JSON produces the original values.

- [ ] **Step 5: Run OAuth tests, build, and lint**

Run: `npx vitest run src/oauth.test.ts`

Expected: PASS.

Run: `npm run build && npm run lint`

Expected: both commands exit successfully.

- [ ] **Step 6: Commit the remediation**

```bash
git add src/oauth.ts src/oauth.test.ts
git commit -m "fix: prevent OAuth authorize page script injection"
```
