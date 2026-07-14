# Sample Messages Until Bound Design

## Goal

Make the `sample_messages` tool interpret date-only and month-only `until`
bounds inclusively, matching the transaction tools.

## Scope

The change is limited to `sample_messages` in `src/index.ts` and its
regression coverage. Its MCP input schema and response format remain
unchanged.

## Design

`sample_messages` will reuse `expandUntilBound()` from
`transaction-parser.ts` before converting an `until` input to milliseconds.
The handler will compute this expanded timestamp once after input validation
and use it for filtering messages.

The resulting semantics are:

- `YYYY-MM-DD` includes all messages through `23:59:59.999Z` on that UTC day.
- `YYYY-MM` includes all messages through the helper's end-of-month bound.
- A complete ISO timestamp is not expanded and remains an exact upper bound.
- Invalid `until` values retain the existing validation error response.

`since` behavior and message retrieval behavior are out of scope.

## Testing

Add deterministic regression coverage for the tool handler using controlled
messages. The test will verify that a message from midday on a date-only
`until` boundary is included, a later message is excluded, and a month-only
bound includes late-month messages while excluding messages from the following
month.

## Rationale

Reusing `expandUntilBound()` keeps `sample_messages` consistent with the
transaction paths and avoids maintaining a duplicate date-expansion rule in
`index.ts`.
