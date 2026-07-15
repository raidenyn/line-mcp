# OAuth Authorize Page XSS Remediation Design

## Goal

Prevent attacker-controlled OAuth `state` and validated loopback `redirect_uri` values from terminating the authorization page's inline script and injecting markup.

## Design

`authorizePageHtml` will no longer interpolate OAuth context directly into executable JavaScript. It will render a non-executable `<script type="application/json" id="oauth-context">` containing `sid`, `state`, `redirectUri`, and `basePath`.

Before embedding, serialized JSON replaces every `<` character with `\u003c`. This prevents a supplied `</script>` sequence from terminating the JSON script element. The polling script reads the element and parses its text with `JSON.parse`, preserving the existing values and redirect behavior without treating OAuth data as executable source.

## Testing

Add route tests that supply `</script>` payloads in `state` and `redirect_uri`. They must assert that the response contains no literal injected closing-script sequence, the JSON context retains the original logical values after parsing, and existing OAuth redirect behavior remains unchanged.

## Scope

This change is limited to authorization-page serialization and tests. It does not change OAuth parameter validation, selector behavior, token issuance, or LINE login state.
