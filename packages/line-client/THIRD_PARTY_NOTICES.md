# Third-Party Notices

This package (`@raidenyn/line-client`) bundles two binary/generated assets
that are **not** authored by this project and are **not** covered by this
project's own license:

- `assets/ltsm/ltsm.wasm`
- `assets/ltsm/ltsmSandbox.js`

## What these are

Both files are copied as-is from the LINE Messenger Chrome extension
(extension id `ophjlpahpchlmihnnnihgmmeilfjmjjc`, source version `3.7.2`).
`ltsm.wasm` is LINE's WebAssembly crypto module responsible for HMAC signing
and key derivation; `ltsmSandbox.js` is the JavaScript sandbox that loads and
wraps it. `@raidenyn/line-client` runs them, unmodified, inside a headless
DOM sandbox (see `src/signer.ts`) purely so its requests are signed exactly
the way the genuine extension signs them — this project does not, and could
not, re-implement LINE's proprietary signing algorithm independently.

Full retrieval, ownership, and hash/size provenance details are recorded in
[`assets/ltsm/provenance.json`](assets/ltsm/provenance.json) and
[`assets/ltsm/README.md`](assets/ltsm/README.md).

## Ownership and license status

These two files are proprietary artifacts owned by **LINE Corporation**. No
license grant permitting redistribution has been obtained or is known to
exist. Do not edit, decompile, or otherwise transform them.

## Where these files may be distributed

- **This source repository** — approved, as build-time dependencies of the
  reverse-engineered client.
- **Docker images built from this repository** — approved, for running this
  server internally.
- **Internal tarballs** (e.g. `npm pack` output installed into a private or
  internal target) — approved, for internal testing and distribution only.
- **Public npm registry (or any other public package index)** — **not
  approved**. Publishing a package that bundles these files publicly is
  blocked pending a legal review of LINE Corporation's redistribution rights.
  No task in this project's modularization effort (issue #75) performs, or is
  authorized to perform, a public `npm publish` of this package.

## Everything else in this package

All other source code in `@raidenyn/line-client` (the TypeScript under
`src/`, excluding the two vendored files above) is original work covered by
this project's own license.
