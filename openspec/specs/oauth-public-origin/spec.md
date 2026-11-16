# oauth-public-origin Specification

## Purpose

How the externally advertised OAuth issuer, protected resource and endpoints are derived from the validated PUBLIC_URL and BASE_PATH, and the guarantee that the OAuth flow never depends on the request Host or X-Forwarded-* headers.

## Requirements

### Requirement: Public origin derived from PUBLIC_URL and BASE_PATH

The server MUST derive the OAuth issuer as `<public origin><BASE_PATH>` and the protected resource as `<issuer>/mcp`, where the public origin is the validated `PUBLIC_URL`. When `PUBLIC_URL` is unset or blank, the public origin MUST be `http://localhost:<PORT>`. `BASE_PATH` MUST appear exactly once in every advertised URL.

#### Scenario: Discovery metadata uses PUBLIC_URL

- **WHEN** `PUBLIC_URL=https://mcp.example.com` and `BASE_PATH=/line-mcp` and a client requests `/.well-known/oauth-authorization-server/line-mcp`
- **THEN** `issuer` is `https://mcp.example.com/line-mcp`
- **AND** `authorization_endpoint`, `token_endpoint` and `registration_endpoint` are `https://mcp.example.com/line-mcp/authorize`, `/token` and `/register`

#### Scenario: Protected-resource metadata uses PUBLIC_URL

- **WHEN** a client requests `/.well-known/oauth-protected-resource/line-mcp/mcp`
- **THEN** `resource` is `https://mcp.example.com/line-mcp/mcp`
- **AND** `authorization_servers` is `["https://mcp.example.com/line-mcp"]`

#### Scenario: The 401 challenge points at the public metadata URL

- **WHEN** `POST /line-mcp/mcp` is sent without a valid bearer token
- **THEN** the `WWW-Authenticate` header's `resource_metadata` is `https://mcp.example.com/.well-known/oauth-protected-resource/line-mcp/mcp`

#### Scenario: Unset PUBLIC_URL keeps the localhost behavior

- **WHEN** `PUBLIC_URL` is unset and `PORT=3000`
- **THEN** issuer, resource and all endpoints are identical to those produced before this change (`http://localhost:3000<BASE_PATH>...`)

### Requirement: PUBLIC_URL validation fails closed

`PUBLIC_URL` MUST be an absolute origin using `https:` or `http:`, with no userinfo, query, fragment, or path other than `/`. Case, a default port and a trailing slash MUST be normalized. A non-loopback `http:` origin (loopback: `localhost`, `127.0.0.1`, `[::1]`) MUST be accepted and MUST log a startup warning. Any other invalid value MUST abort server start-up with an error that names `PUBLIC_URL` and, for a path, points to `BASE_PATH`.

#### Scenario: A path in PUBLIC_URL is rejected

- **WHEN** the server starts with `PUBLIC_URL=https://mcp.example.com/line-mcp`
- **THEN** start-up fails before listening and the error says to use `BASE_PATH` for the path

#### Scenario: A non-loopback http origin warns but starts

- **WHEN** the server starts with `PUBLIC_URL=http://192.168.1.10:3000`
- **THEN** the server starts, the issuer is `http://192.168.1.10:3000<BASE_PATH>`, and a warning naming `PUBLIC_URL` is written to stderr

#### Scenario: Other invalid values are rejected

- **WHEN** the server starts with `PUBLIC_URL` set to `ftp://x`, `not a url`, `https://u:p@mcp.example.com`, or `https://mcp.example.com?x=1`
- **THEN** start-up fails with an error naming `PUBLIC_URL`

#### Scenario: A trailing slash is normalized

- **WHEN** `PUBLIC_URL=https://mcp.example.com/`
- **THEN** the issuer has no doubled slash and equals `https://mcp.example.com<BASE_PATH>`

#### Scenario: Case and default port are normalized

- **WHEN** `PUBLIC_URL=https://MCP.Example.com:443`
- **THEN** the issuer origin is `https://mcp.example.com`

### Requirement: Configuration validated before any side effect

Both servers MUST validate `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` and `TRUST_PROXY` as the first action of start-up, before any data migration, database or secret file creation, or worker start. An invalid value MUST leave the data root untouched.

#### Scenario: Invalid configuration creates nothing

- **WHEN** a server is started against an empty data root with an invalid `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_URIS` or `TRUST_PROXY`
- **THEN** start-up rejects with an error naming the variable
- **AND** the data root contains no files afterwards

### Requirement: Import upload URLs use the same origin

When `PUBLIC_URL` is set, upload URLs for the import service MUST use the same public origin and `BASE_PATH` as the OAuth issuer, and MUST NOT consult request headers.

#### Scenario: Upload URL matches the issuer origin

- **WHEN** `PUBLIC_URL=https://mcp.example.com` and an import is initiated over a request whose `Host` is `internal:3000`
- **THEN** the upload URL starts with `https://mcp.example.com<BASE_PATH>/import-upload`

#### Scenario: Import URL normalized like the issuer

- **WHEN** `PUBLIC_URL=https://MCP.Example.com/`
- **THEN** the upload URL starts with `https://mcp.example.com<BASE_PATH>/import-upload`

### Requirement: OAuth flow independent of the Host header

Issuer, audience, discovery documents, challenges, authorization codes and issued tokens MUST NOT depend on the `Host` or `X-Forwarded-*` headers of any request. An authorization code obtained through one host name MUST be redeemable at `/token` through another, and the issued tokens MUST be accepted at `/mcp` regardless of the `Host` used.

#### Scenario: Token endpoint called with a different Host than the browser

- **WHEN** a code is issued after `/authorize` was loaded with `Host: mcp.example.com` and `/token` is then called with `Host: internal:3000`
- **THEN** the code is redeemed successfully
- **AND** a `POST /mcp` carrying the issued access token and a third `Host` is not answered with 401

#### Scenario: Forwarded headers do not alter metadata

- **WHEN** discovery metadata is requested with `X-Forwarded-Host: evil.example` and `X-Forwarded-Proto: http`
- **THEN** the response is byte-identical to one requested without those headers
