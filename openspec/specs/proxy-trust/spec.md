# proxy-trust Specification

## Purpose

The opt-in TRUST_PROXY setting, which request-derived values may honor forwarded headers, and the rule that the OAuth issuer and discovery stay independent of request headers.

## Requirements

### Requirement: Opt-in proxy trust

The server MUST honor `X-Forwarded-Proto` and `X-Forwarded-Host` only when `TRUST_PROXY` is set to a truthy value: `true` (case-insensitive), a non-negative integer hop count, or a comma-separated list of `loopback`, `linklocal`, `uniquelocal`, IP addresses or CIDR ranges. When `TRUST_PROXY` is unset, blank, `false` (case-insensitive) or `0`, forwarded headers MUST be ignored. Any other value MUST abort start-up with an error naming `TRUST_PROXY`, raised by the server's own validation rather than by Express.

#### Scenario: Off by default

- **WHEN** `TRUST_PROXY` is unset and `PUBLIC_URL` is unset and a request carries `X-Forwarded-Proto: https`
- **THEN** `req.protocol` is the direct connection's protocol and `req.host` is its `Host` (verified through a real Express request, not a stub)

#### Scenario: Forwarded headers honored when trusted

- **WHEN** `TRUST_PROXY=true`, `PUBLIC_URL` is unset, and a request carries `X-Forwarded-Proto: https` and `X-Forwarded-Host: mcp.example.com`
- **THEN** `req.protocol` is `https` and `req.host` is `mcp.example.com` (verified through a real Express request)

#### Scenario: Invalid value fails start-up

- **WHEN** `TRUST_PROXY` is `-3`, `1.5`, `yes` or `10.0.0.0/99`
- **THEN** start-up fails with an error naming `TRUST_PROXY`

#### Scenario: Case-insensitive booleans

- **WHEN** `TRUST_PROXY=TRUE`
- **THEN** it behaves as `true`

### Requirement: PUBLIC_URL takes precedence over forwarded headers

When `PUBLIC_URL` is set, no emitted URL MAY be derived from request headers, whether or not `TRUST_PROXY` is set. `TRUST_PROXY` MUST NOT influence the issuer, resource, token claims, discovery documents or the `WWW-Authenticate` challenge in any configuration.

#### Scenario: Forwarded host ignored with PUBLIC_URL set

- **WHEN** `PUBLIC_URL=https://mcp.example.com`, `TRUST_PROXY=true`, and a request carries `X-Forwarded-Host: other.example`
- **THEN** import upload URLs and discovery metadata still use `https://mcp.example.com`

### Requirement: Login flow emits no request-derived absolute URLs

The authorization page, QR login and post-login redirect MUST NOT embed absolute URLs derived from request headers. The page MUST address server endpoints relative to `BASE_PATH` and MUST redirect only to the validated client `redirect_uri`.

#### Scenario: Authorization page behind a proxy

- **WHEN** `/authorize` is served with `Host: internal:3000` and `X-Forwarded-Host: mcp.example.com`
- **THEN** the page contains no absolute URL derived from `Host` or `X-Forwarded-*`; its embedded context holds only the session id, state, `basePath` and the client-supplied `redirectUri`
