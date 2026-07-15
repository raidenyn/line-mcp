# Reusable LINE Authentication Design

## Goal

Fix issue #41 so ordinary MCP token refreshes survive server restarts and a genuinely new OAuth authorization can reuse a saved LINE certificate. Repeat authorization should require only QR confirmation when LINE accepts the certificate, while stale certificates should fall back to the existing PIN flow.

The implementation must support multiple LINE accounts, identify them by human-readable profile names in the account selector, and never report login success before the resulting credentials are durably stored.

## Scope

This change covers:

- validation, enumeration, and atomic replacement of persisted LINE auth records;
- persisted account display names for account selection;
- zero-, one-, and multiple-account authorization behavior;
- certificate-only QR login initialization;
- persistence ordering during login and LINE token rotation;
- refresh-token continuity across restarts with the same signing secret; and
- unit and route tests for these behaviors.

It does not add credential encryption, change MCP refresh-token lifetime or revocation, prevent authorization after the OAuth client loses its refresh token, or redesign unrelated session cleanup and logging.

## Chosen Approach

Extend the existing file-backed auth store and pass an explicitly selected certificate into QR login. This preserves the current one-file-per-MID layout and keeps stale access credentials out of unauthenticated QR bootstrap calls.

Initializing `LineClient` with the complete saved `AuthData` was rejected because it would couple certificate reuse to active API authentication and could attach stale access credentials to QR setup requests. Moving auth records to SQLite was rejected because it would introduce an unnecessary migration and broader storage changes.

## Persisted Auth Records

Each `DATA_DIR/auth/<mid>.json` file contains all seven non-empty `AuthData` string fields and may also contain a non-empty `displayName` string. Existing files containing only `AuthData` remain valid; their selector label falls back to a masked MID until a later successful login records a profile name.

A single parser validates records used by loading and enumeration. It rejects:

- filenames whose stem is not a safe MID;
- payloads with a missing, empty, or non-string `AuthData` field;
- payload MIDs that do not match the filename;
- an invalid `displayName` value when that property is present; and
- corrupt JSON.

Enumeration examines only regular `*.json` entries in the auth directory. An invalid record is logged without including any credential field and does not prevent other valid records from being returned. Loading a valid record may populate `latestAuthData`, but account enumeration itself must not replace fresher in-memory credentials.

`persistAuthData` accepts the completed credentials and optional display name and reports failure by throwing. It creates the auth directory with mode `0700`, writes the complete JSON to a uniquely named temporary file in that same directory with mode `0600`, and renames the temporary file over `<mid>.json`. Writing in the destination directory makes the rename atomic on the supported local filesystem. A failed write or rename removes the temporary file when possible and propagates a sanitized error to the caller.

## Account Display Names

After QR login and encrypted identity retrieval have produced complete credentials, `LineClient` fetches the authenticated account's LINE profile display name through a focused method. Profile lookup is metadata enrichment rather than an authentication prerequisite: if it fails, the completed credentials remain valid and the store uses the existing display name for that MID when available, otherwise the masked-MID fallback.

Selector labels use the stored `displayName`. Duplicate display names are allowed because selection is based on a server-side opaque option identifier, not the label. A fallback MID reveals only a short prefix and suffix, such as `u123...cdef`, and never the full identifier.

## OAuth Account Selection

`GET /authorize` first performs the existing OAuth parameter validation, then enumerates valid saved accounts:

- With zero accounts, it starts first-time QR login without a certificate.
- With one account, it automatically selects that record and starts QR login with its certificate.
- With multiple accounts, it creates a short-lived in-memory selection session and returns an account selector before creating any LINE QR session.

The selection session stores the validated OAuth request and maps random opaque option identifiers to account MIDs. The HTML contains only the account labels, selection-session ID, and opaque option identifiers. It contains no MID, access token, LINE refresh token, certificate, identity-key field, or filesystem path.

Submitting the selector to a dedicated route consumes the option from the selection session, reloads the corresponding record, and validates it again. Unknown, expired, reused, tampered, deleted, or newly invalid selections return a controlled `400` response that instructs the user to restart authorization. The browser cannot nominate an arbitrary path, MID, or credential payload.

The selector and QR page honor `BASE_PATH`. OAuth state, PKCE values, client ID, and redirect URI remain server-side while selection is pending.

## Certificate-Only QR Login

`LineClient.login` accepts an optional saved certificate dedicated to the pending QR flow. It does not infer that certificate from active auth and does not install saved access or refresh tokens. Consequently, `createSession` and `createQrCode` continue to run without an `x-line-access` header.

After QR confirmation, `verifyCertificate` remains the required state-machine transition:

- If LINE accepts the selected certificate, `waitForPin()` resolves with `null`, and `createPinCode` and `checkPinCodeVerified` are skipped.
- If LINE rejects a missing or stale certificate with the expected client/API rejection, login continues through the existing PIN flow once.
- Network failures and unexpected server failures are not treated as certificate rejection and fail the login.

`qrCodeLoginV2` supplies the replacement certificate and tokens in both successful paths. Encrypted identity retrieval completes the new `AuthData`, replacing stale persisted values after durable storage succeeds.

## Completion and Persistence Ordering

`monitorLogin` waits for full LINE login, obtains complete credentials, and attempts profile-name enrichment. It then atomically persists the new record before it:

- updates `latestAuthData`;
- creates an entry in `pendingCodes`;
- attaches the authorization code to the browser session; or
- changes the browser session phase to `complete`.

If durable persistence fails, the session changes to `failed` with an actionable but credential-free message. No authorization code is created, so `/token` cannot exchange credentials from a login that was not saved. The old account file remains intact when atomic replacement fails.

## Refresh Continuity

MCP access and refresh tokens remain self-contained and signed by `data/secret`. With the same secret, a still-valid MCP refresh token remains verifiable after restart and does not invoke `/authorize`.

When issuing or validating MCP tokens, the server uses credentials in this order for the token's MID:

1. the current process's `latestAuthData` entry;
2. a valid persisted record; and
3. the credentials embedded in the valid signed token.

When `LineClient` rotates LINE tokens, its callback updates `latestAuthData` and atomically replaces the matching persisted record while retaining its display name. A persistence failure is logged without secrets; the rotated credentials remain usable in memory for the current process, but the server does not claim they were durably saved. A later refresh or successful login may repair the disk record.

Deleting or changing `data/secret`, losing the OAuth client's MCP refresh token, or invalidating the signed refresh token still requires a new OAuth flow. Persisted certificate reuse makes that fallback QR-only when LINE accepts the certificate.

## Security and Error Handling

- Logs may identify the operation and a masked MID but never include access tokens, refresh tokens, certificates, identity-key fields, or raw record contents.
- Auth directory and file permissions remain `0700` and `0600`, respectively.
- Filesystem paths are derived only from validated MIDs and are checked to remain under the auth directory.
- Credentials and full MIDs never enter selector HTML, query parameters, browser storage, or client-side logs.
- Corrupt records and profile lookup failures do not block other valid accounts.
- Persistence failure blocks OAuth completion; expected certificate rejection falls back to PIN.

## Testing

Auth-store unit tests cover:

- zero, one, and multiple valid records;
- legacy records without `displayName`;
- corrupt JSON, incomplete fields, invalid display names, unsafe filenames, and MID mismatches;
- isolation of invalid records from valid records;
- `0700` directory and `0600` file permissions;
- atomic replacement and cleanup behavior; and
- surfaced write and rename failures.

`LineClient` unit tests cover:

- QR bootstrap requests receiving no saved access token;
- an accepted saved certificate skipping PIN creation and polling;
- a rejected saved certificate entering the PIN path;
- unexpected certificate-verification failures aborting login; and
- successful profile display-name lookup and non-fatal lookup failure.

OAuth route and session tests cover:

- no-account first-time login;
- one-account automatic selection;
- multiple-account selector rendering with display names and masked fallback labels;
- duplicate display names selecting the correct server-side record;
- invalid, expired, reused, or newly invalid selections returning `400`;
- selector HTML containing no full MID or credential value;
- `BASE_PATH` behavior for selector submission and polling;
- persistence failure leaving the session failed with no pending authorization code; and
- persistence occurring before a session can report completion.

Token tests simulate a fresh module/process using the same `data/secret` and persisted auth directory. A previously issued signed MCP refresh token must produce new MCP tokens using the persisted LINE credentials without calling `/authorize`. They also verify that a persisted LINE token rotation is used after restart.

## Manual Acceptance

1. Complete a first login. QR plus PIN may be required, and a valid account record with a display name is durably created.
2. Restart the server and use the existing connector. No browser authorization is requested.
3. Force a new OAuth authorization with one saved account. QR confirmation is sufficient when LINE accepts the certificate.
4. Add a second valid saved account. A selector showing human-readable account names appears before QR creation, and the chosen certificate is used.
5. Use a rejected or stale certificate. PIN appears once, the new certificate replaces the old record, and the next authorization is QR-only when LINE accepts it.
6. Make the auth directory unwritable. Login reports a persistence failure and does not redirect with an authorization code.
