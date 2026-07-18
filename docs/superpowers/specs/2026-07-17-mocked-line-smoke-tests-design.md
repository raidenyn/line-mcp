# Mocked LINE Smoke Tests Design

## Summary

Add deterministic, credential-free regression tests that run a strict mocked
LINE gateway concurrently with the real composed and standalone application
CLIs. The mock will emulate the observed LINE Chrome API protocol, validate
every request contract and HMAC, and provide meaningful chat, message, image,
login, and token-refresh responses.

The new `npm run test:smoke` command will own startup and teardown of every
process. It will exercise both seeded credentials and the full OAuth/QR/PIN
flow against both application targets. The existing live `npm run test:e2e`
suite remains unchanged and continues to require `.line-auth.json`.

## Goals

- Run meaningful end-to-end smoke tests without real LINE credentials.
- Exercise the real compiled application CLIs, MCP HTTP transport, OAuth,
  SQLite persistence, LINE client, real WASM HMAC signer, and tool handlers.
- Validate each LINE request's method, headers, body, authentication, HMAC, and
  state-machine position.
- Cover both the composed ten-tool server and standalone five-tool server.
- Cover both pre-seeded fake credentials and first-time OAuth authorization.
- Cover core failures: token refresh, unauthorized access, bad HMAC,
  malformed request bodies, and invalid pagination boundaries.
- Guarantee cleanup of all child processes, process groups, ports, transports,
  and temporary data roots on success or failure.
- Add the deterministic suite as a separate PR-blocking CI job.

## Non-Goals

- Replace the manual live-account e2e suite.
- Reproduce every undocumented LINE endpoint or every possible server error.
- Add broad latency, timeout, malformed-response, or 5xx fault injection in the
  first version.
- Package or publish the mock as a production workspace package.
- Modify the vendored LTSM assets.

## Architecture

### Explicit LINE gateway seam

The production code receives one explicit configuration seam rather than
containing test-specific routing logic:

- `LineClient` accepts an optional gateway base URL. Its default remains
  `https://line-chrome-gw.line-apps.com`.
- `createLineClient` exposes the same option through `LineClientOptions`.
- Request-client factory options carry the gateway URL into clients used by
  tools, bank message readers, imports, and the sync loop.
- OAuth-created login clients receive the same gateway URL through
  `LineAuthProvider` and `mountOAuthRoutes` dependencies.
- Composed and standalone server options accept the gateway URL explicitly.
- Each CLI reads `LINE_API_BASE_URL` and passes it to its server factory. No
  package entry point reads that environment variable.

The client normalizes one trailing slash from the configured base before
joining API paths. Image URLs remain absolute and are fetched unchanged, which
allows mock responses to point at locally served image fixtures.

No behavior changes when `LINE_API_BASE_URL` is absent.

### Mock LINE gateway

`tests/support/mock-line-server/` contains a standalone test executable, not a
seventh workspace package. It may depend on public workspace APIs but no
production package may import it.

Responsibilities are separated as follows:

- `fixtures.ts`: immutable account, chat, contact, message, image, identity,
  certificate, and expected-output fixtures.
- `contracts.ts`: method, header, raw-body, HMAC, token, and identifier
  validation plus redacted diagnostics and LINE-shaped errors.
- `state.ts`: QR sessions, certificates, issued access/refresh tokens,
  pagination, request traces, expected rejections, and unexpected violations.
- `server.ts`: LINE routes, image routes, and test-control routes.
- `cli.ts`: port binding, machine-readable readiness output, signal handling,
  final verification, and process exit status.

The mock stores no persistent state. The harness resets it before each isolated
scenario. It binds only to `127.0.0.1` and receives a random control token from
the harness. The control surface is fixed:

- `GET /__mock/health`: readiness.
- `POST /__mock/reset`: reset protocol state and traces for one scenario.
- `POST /__mock/configure`: select seeded/full-auth token and rejection
  expectations.
- `GET /__mock/report`: return route counts, state, and violations.
- `POST /__mock/shutdown`: perform final verification and stop gracefully.

All control routes require the control token and are outside the LINE route
namespace.

### Smoke harness

`tests/support/process-harness.ts` owns child processes and temporary roots.
`tests/smoke/mock-line-smoke.test.ts` uses it to run four scenarios:

1. Composed server with seeded fake credentials.
2. Composed server through full OAuth/QR/PIN authorization.
3. Standalone server with seeded fake credentials.
4. Standalone server through full OAuth/QR/PIN authorization.

One mock process remains alive for the suite. Application scenarios run
sequentially against reset mock state so route counts and auth state cannot
leak. During every scenario, the mock and the application are concurrent
processes. Each application receives its own port and temporary data root.

The harness starts compiled CLIs with `node`, rather than importing server
factories into the Vitest process. This verifies the same executable boundary
used in production.

## Mock Protocol

### Common request validation

Every LINE API handler validates:

- HTTP method and exact route.
- JSON content type and parseable raw request body.
- Chrome extension headers used by the real client: `accept`,
  `accept-language`, `origin`, `user-agent`, `x-lal`, and
  `x-line-chrome-version`.
- Required and forbidden authorization and long-poll headers.
- Exact argument array shape, field names, value types, constants, counts, and
  state-bound identifiers.
- A cryptographically valid `x-hmac` for the exact path and unmodified raw JSON
  body.

Extra fields, missing fields, wrong constants, unknown routes, invalid MIDs,
unknown message boundaries, and invalid state transitions are rejected. Each
rejection returns a meaningful LINE-shaped response and records a redacted
contract diagnostic containing expected and actual values. Secrets, full
tokens, certificates, nonce material, and full account MIDs are never logged.

An unexpected contract violation remains in the final verification report, so
the suite fails even if a higher application layer catches and masks the
upstream error.

### HMAC verification

The mock process uses the public `signForAccount` API from
`@raidenyn/line-client` with known-valid storage-key material already exercised
by the package artifact test. Because LINE HMAC derivation depends on the
access token, path, and body, but not the storage encryption key, this produces
the expected signature for pre-auth and authenticated calls.

For each request, the mock derives the HMAC key using the applicable access
token, then signs:

```text
request path + raw JSON body
```

using the real shipped WASM algorithm. Pre-auth requests use an empty access
token. Authenticated requests use the exact current token from
`x-line-access`. The expected and supplied base64 signatures are compared with
a timing-safe byte comparison.

### QR, PIN, and certificate state machine

The mock enforces this sequence:

```text
createSession
  -> createQrCode
  -> checkQrCodeVerified
  -> verifyCertificate
  -> accepted certificate OR createPinCode -> checkPinCodeVerified
  -> qrCodeLoginV2
  -> getEncryptedIdentityV3
```

Specific behavior:

- `createSession` returns a unique deterministic-format `authSessionId`.
- `createQrCode` accepts only that session and returns a realistic LINE callback
  URL plus polling limits.
- QR and PIN polls require `x-lst: 150000` and a matching
  `x-line-session-id`.
- The mock completes polls deterministically without a real mobile device.
- An empty, stale, or unknown certificate returns LINE API code `10051` with
  nested code `2`.
- `createPinCode` is legal only after that certificate rejection and returns a
  six-digit fixture PIN.
- `qrCodeLoginV2` checks `systemName`, `modelName`,
  `autoLoginIsRequired`, and the completed session state before issuing tokens
  and a replacement certificate.
- A replacement certificate is accepted by the next authorization and skips
  PIN creation and polling.
- `getEncryptedIdentityV3` requires the newly issued access token and returns
  valid storage-key material.
- `getProfile` returns the authenticated fixture MID and display name so the
  application persists a complete named credential record.

### LINE tokens and refresh

Mock access tokens are structurally realistic JWTs containing `iat`, `exp`,
`aud`, scope, version, account, login-session, device, client-type, and
client-mode claims. The mock tracks issuance independently of JWT structure;
an unissued token is invalid even if its payload looks valid.

Authenticated routes require the current unexpired access token. Superseded,
expired, malformed, or unknown tokens are rejected.

`POST /api/auth/tokenRefresh`:

- Requires exactly `{ "refreshToken": "..." }`.
- Forbids `x-line-access` and `x-hmac`, matching the observed refresh request.
- Rejects unknown or already-rotated refresh tokens.
- Issues a fresh access token and rotates the refresh token.
- Causes subsequent authenticated requests to reject the old access token.

### Data fixtures and pagination

The deterministic dataset contains:

- One LINE account with a stable MID and display name.
- One group chat and one direct contact chat with names and image metadata.
- Named contacts for every message sender.
- Text messages, parseable bank-notification messages, and an image message.
- At least 200 generated but meaningful history messages so the application's
  default range page size reaches the previous-message endpoint.
- A previous page that re-includes the boundary message, matching observed LINE
  behavior and exercising deduplication/progress logic.
- A small valid JPEG served by the same mock process with an exact MIME type.

`getRecentMessagesV2` honors the requested count and returns newest-first data.
`getPreviousMessagesV2WithRequest` validates the complete boundary object and
returns only fixture messages at or before the expected boundary, including
the deliberate boundary re-inclusion. A known end-of-history boundary returns
an empty page; malformed boundaries or boundaries belonging to another chat
are errors rather than empty successful responses.

## Smoke Scenarios

### Seeded credential path

Before application startup, the harness writes:

- A valid credential-store record containing mock LINE auth data.
- A known MCP signing secret at the target data root.
- A near-expiry mock LINE JWT and valid mock refresh token.

The harness mints a normal versioned MCP access token with
`@raidenyn/mcp-runtime`'s token codec using the target's actual issuer,
audience, MID, and `line` scope. It does not use the `TEST_TOKEN` bypass. This
works identically for composed and standalone targets and exercises production
MCP bearer verification.

The first LINE-backed tool call triggers LINE token refresh. The scenario
asserts:

- Exactly one valid refresh request occurred.
- Subsequent requests use the rotated access token and matching HMAC.
- The credential record on disk contains the rotated token pair.
- The pre-refresh credential object was not silently reused.

### Full OAuth path

The harness starts from an empty data root and drives the public OAuth HTTP
surface without a browser:

1. Fetch authorization metadata.
2. Register a dynamic client.
3. Generate a PKCE verifier/challenge and call `/authorize`.
4. Parse the opaque application login-session ID from the HTML JSON context.
5. Poll `/authorize/poll` through PIN-required and complete phases.
6. Exchange the authorization code with the PKCE verifier.
7. Connect an MCP client with the issued access token.
8. Call a LINE-backed tool and assert fixture data.
9. Exchange the MCP refresh token and use the replacement access token.
10. Start a second authorization against the same data root and assert the
    persisted LINE certificate is accepted with no PIN route calls.

The scenario also verifies MCP requests with no bearer, an invalid bearer, and
an expired bearer receive the expected authorization challenge or rejection.

### Tool assertions

Both targets assert exact, fixture-derived outcomes for:

- Tool names and absence of extra tools.
- Resource URIs and non-empty guide content.
- `list_chats` group/contact names, MIDs, types, counts, and picture URLs.
- `get_messages` order, timestamps, sender names, text, and image preview URL.
- Range pagination and cache-backed repeated reads.
- `get_image` MIME type and decoded bytes.
- `initiate_import` and `complete_import` using a deterministic export file.

The composed target additionally exercises all bank tools:

- `sample_messages` returns exact raw fixture messages and time filtering.
- `manage_templates` creates, lists, applies, and deletes deterministic
  templates.
- `manage_categories` performs an exact upsert/list/delete round trip.
- `get_transactions` returns exact parsed amount, currency, merchant, date,
  balance, and category fields, including representative filters.
- `summarize_transactions` returns exact totals for representative groupings.

The standalone target asserts that bank tools and bank guide resources are
absent.

All fixture-dependent assertions are unconditional. The suite contains no
"find any chat", "if an image exists", or "if templates exist" branches and no
fixture-based skips.

### Core negative probes

Dedicated mock contract tests send deliberately invalid requests and assert
rejection for:

- Missing or incorrect HMAC.
- Expired and superseded access tokens.
- Wrong refresh token.
- Missing authenticated headers.
- Extra or malformed request parameters.
- Incorrect session IDs and illegal QR/PIN transitions.
- Unknown pagination boundaries.

Expected negative probes are tracked separately from application-originated
violations and reset before each app scenario. They therefore prove strictness
without making the final zero-unexpected-violations assertion ambiguous.

## Error Handling and Lifecycle

### Process readiness

The mock binds an ephemeral port and emits one machine-readable readiness line
containing the selected port. Application ports are selected before spawn and
confirmed through `/healthz`. Every readiness wait has a deadline and checks
for early child exit.

If a process exits or readiness times out, the error includes captured stdout
and stderr with secrets redacted.

### Cleanup

The harness registers cleanup immediately after every successful spawn.
Cleanup order is:

1. Close MCP transports and clients.
2. Request graceful app shutdown with `SIGTERM` to the process group.
3. Wait for bounded graceful exit.
4. Kill the process group after the deadline if descendants remain.
5. Reset or stop the mock as appropriate.
6. Remove temporary data roots.

Cleanup runs in `finally` blocks and suite-level teardown, including when setup
fails partway through. Repeated cleanup calls are idempotent. A cleanup failure
is reported without hiding the original test failure.

At each scenario end, the harness reads the mock report and asserts:

- No unexpected contract violations.
- Required routes were called the expected number of times.
- The expected login branch and refresh behavior occurred.
- No unresolved QR session or pending request remains.

The mock exits nonzero if stopped with unconsumed unexpected violations.

## Test and Command Organization

The main command is self-contained:

```json
{
  "test:smoke": "npm run build && vitest run tests/smoke"
}
```

The build ensures the harness starts current compiled CLIs and current package
entry points. The existing commands retain their meanings:

- `npm run test:unit`: fast unit, contract, migration, and architecture tests.
- `npm run test:smoke`: deterministic mock-backed process-level smoke tests.
- `npm run test:e2e`: manual live LINE account tests requiring
  `.line-auth.json`.
- Docker smoke: container startup and exact tool-surface checks for both images.

Focused unit tests cover gateway URL normalization/defaulting and option
threading. Mock contract tests cover the strict protocol implementation. The
process scenarios provide the end-to-end regression coverage.

## CI and Documentation

Add a separate `smoke` job to `.github/workflows/ci.yml`:

1. Check out the repository.
2. Set up Node 24 with npm caching.
3. Run `npm ci`.
4. Run `npm run test:smoke`.

The job requires no secrets, LINE credential file, or Docker daemon and is a
PR-blocking deterministic gate.

Update `README.md` and `CLAUDE.md` to document the new command, process model,
credential-free behavior, and distinction from live and Docker e2e checks.

## Security and Isolation

- Production defaults never point to the mock.
- The override is explicit and owned by CLI configuration.
- Every URL the harness or app fetches is local. The rendered QR payload may
  contain a syntactically realistic `line.me` callback URL, but neither the
  harness nor application dereferences it.
- Mock diagnostics redact credentials and token material.
- Temporary auth records and signing secrets exist only under throwaway roots.
- The mock is outside production package graphs and Docker runtime copies.
- Existing package import-boundary tests remain unchanged and must pass.
- Vendored proprietary LTSM files remain untouched and unpublished.

## Acceptance Criteria

- `npm run test:smoke` succeeds on a machine with no `.line-auth.json` and no
  LINE environment credentials.
- The command starts the strict mock and real app concurrently, runs all four
  scenarios, and leaves no child processes or temporary roots behind.
- A changed LINE path, body parameter, required header, access token, or HMAC
  causes a precise deterministic failure.
- Seeded scenarios prove LINE token rotation and credential persistence for
  composed and standalone targets.
- Full-auth scenarios prove PKCE authorization, first-login PIN flow,
  certificate reuse, MCP token issuance/refresh, and authenticated tool calls
  for both targets.
- Composed smoke covers all ten tools; standalone smoke covers all five tools
  and rejects bank-surface assumptions.
- The new smoke CI job passes without credentials or Docker.
- `npm run test:unit`, `npm run lint`, and `npm run build` continue to pass.
- The existing live e2e suite remains available and semantically unchanged.
