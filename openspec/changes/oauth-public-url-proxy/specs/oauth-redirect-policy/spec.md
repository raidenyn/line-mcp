## ADDED Requirements

### Requirement: Redirect URI allowlist configuration

The server MUST accept `OAUTH_ALLOWED_REDIRECT_URIS` as a comma-separated list. Each entry MUST be an `https:` URL without userinfo, fragment or `*`. An entry with no path (or only `/`) is an origin entry; an entry with a path is an exact-URL entry. Whitespace and empty entries MUST be ignored; an invalid entry MUST abort start-up naming `OAUTH_ALLOWED_REDIRECT_URIS`.

#### Scenario: Origin entry

- **WHEN** the list is `https://client.example.com`
- **THEN** `https://client.example.com/oauth/callback` is allowed and `https://client.example.com.evil.test/cb` is not

#### Scenario: Exact URL entry

- **WHEN** the list is `https://client.example.com/oauth/callback`
- **THEN** only that URL is allowed and `https://client.example.com/other` is not

#### Scenario: Look-alike and decorated redirect URIs never match

- **WHEN** the list is `https://client.example.com`
- **THEN** `https://client.example.com@evil.test/cb`, `https://client.example.com:8443/cb`, `https://client.example.com/cb#x` and `https://u@client.example.com/cb` are all disallowed

#### Scenario: Blank list is unset

- **WHEN** the value is `" , "`
- **THEN** the policy is the loopback-only default

#### Scenario: Invalid entry fails start-up

- **WHEN** the list contains `http://client.example.com/cb`, `https://*.example.com`, `https://a.com/cb#frag`, or `javascript:alert(1)`
- **THEN** the server refuses to start with an error naming `OAUTH_ALLOWED_REDIRECT_URIS`

### Requirement: Loopback-only default

When `OAUTH_ALLOWED_REDIRECT_URIS` is unset or blank, the policy MUST allow only `http:` or `https:` redirect URIs whose host is `localhost` or `127.0.0.1`. Loopback redirect URIs MUST remain allowed when an allowlist is configured. No other scheme MAY ever be allowed.

#### Scenario: Default rejects an https callback

- **WHEN** `OAUTH_ALLOWED_REDIRECT_URIS` is unset and `/authorize` receives `redirect_uri=https://client.example.com/cb`
- **THEN** the response is 400 and the login flow does not start

#### Scenario: Loopback still allowed with an allowlist

- **WHEN** an allowlist is configured and `/authorize` receives `redirect_uri=http://127.0.0.1:53682/callback`
- **THEN** the request is accepted

### Requirement: Enforcement at authorization

`/authorize` MUST reject, with HTTP 400 and without redirecting or starting a LINE login, any `redirect_uri` the policy disallows. Rejection MUST NOT redirect to the offending URI.

#### Scenario: Allowed https redirect accepted

- **WHEN** the allowlist contains `https://client.example.com/oauth/callback` and `/authorize` receives that `redirect_uri` with valid PKCE parameters
- **THEN** the authorization page is served

#### Scenario: Other https redirect rejected

- **WHEN** the same allowlist is configured and `/authorize` receives `redirect_uri=https://attacker.example/cb`
- **THEN** the response is 400 and no LINE login is started

#### Scenario: Non-http schemes rejected even if loopback-shaped

- **WHEN** `/authorize` receives `javascript://localhost/%0Aalert(1)` or `data://localhost/x`
- **THEN** the response is 400

### Requirement: Enforcement at client registration

`POST /register` MUST, when `redirect_uris` is present, require it to be an array of strings that the policy allows, and otherwise respond 400 with `error: "invalid_redirect_uri"` and not issue a `client_id`. A registration without `redirect_uris` MUST continue to be accepted.

#### Scenario: Registration with an allowed https URI

- **WHEN** the allowlist permits `https://client.example.com/cb` and a client registers `redirect_uris: ["https://client.example.com/cb"]`
- **THEN** the response is 201 and echoes `redirect_uris`

#### Scenario: Registration with a disallowed URI

- **WHEN** a client registers `redirect_uris: ["https://attacker.example/cb"]`
- **THEN** the response is 400 with `error` `invalid_redirect_uri`

#### Scenario: Mixed list is rejected as a whole

- **WHEN** a client registers one allowed and one disallowed URI
- **THEN** the response is 400 and no `client_id` is issued

#### Scenario: Registration without redirect_uris is unchanged

- **WHEN** a client registers with no `redirect_uris`
- **THEN** the response is 201 as before

### Requirement: Redirect destination shown to the user

The QR login page and the account-selector page MUST display the host (and port) of the validated `redirect_uri` the user will be returned to, HTML-escaped.

#### Scenario: Login page names the destination

- **WHEN** `/authorize` is served for `redirect_uri=https://client.example.com/oauth/callback`
- **THEN** the HTML contains `client.example.com` in a visible "You will be returned to" notice

#### Scenario: Selector page names the destination

- **WHEN** more than one account is stored and `/authorize` is served
- **THEN** the account-selector HTML contains the same notice

### Requirement: Token endpoint checks redirect_uri and client_id

When `/token` receives a `redirect_uri` or `client_id` with the `authorization_code` grant, each MUST equal the value stored with the code, otherwise the response MUST be 400 `invalid_grant`. A request that omits them MUST continue to be accepted.

#### Scenario: Mismatching redirect_uri

- **WHEN** a code issued for `https://client.example.com/cb` is redeemed with `redirect_uri=https://other.example/cb`
- **THEN** the response is 400 `invalid_grant`

#### Scenario: Omitted redirect_uri

- **WHEN** the same code is redeemed without `redirect_uri`
- **THEN** the response is 200

### Requirement: Origin entries carry a documented risk

The README MUST warn that an origin entry authorizes every URL on that origin, that exact URLs are preferred, and why (an onward-redirecting page on an allowlisted origin can capture a code from a flow an attacker started).

#### Scenario: README warns

- **WHEN** the README's `OAUTH_ALLOWED_REDIRECT_URIS` documentation is read
- **THEN** it states the origin-entry risk and recommends exact URLs

### Requirement: Unchanged behavior when unconfigured

With `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` and `TRUST_PROXY` all unset, every existing `/register`, `/authorize`, `/token` and discovery response MUST be unchanged, except that `/register` MAY now reject non-loopback `redirect_uris` and the login pages now show the redirect host.

#### Scenario: Existing loopback flow

- **WHEN** none of the new variables is set and a client registers and authorizes with `http://localhost:8123/callback`
- **THEN** the flow completes exactly as it did before this change
