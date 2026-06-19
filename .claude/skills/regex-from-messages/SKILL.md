---
name: regex-from-messages
description: >
  Use this skill when the user wants to build a regex pattern to extract structured fields
  from sample text — especially notification messages, bank alerts, or any repeating
  message format. Invoke it when the user shows example messages and asks to "parse",
  "extract", or "get transactions/data from" them, or when they ask you to write or fix
  a regex for extracting named fields like amount, merchant, date, currency, or balance.
  Also invoke it when the user is debugging a regex that isn't matching as expected.
---

# Regex from Messages

You are helping the user build a regex that reliably extracts structured fields from
a set of sample messages. The goal is a pattern that:

- Uses **named capture groups** (`(?<amount>...)`, `(?<merchant>...)`, etc.)
- Is compiled with the **`s` (dotAll) flag** — `.` matches newlines too
- Handles encoding surprises common in bank/app notifications (non-breaking spaces, etc.)
- Is expressed as a plain string, not a regex literal, so it can be passed in JSON

## Step 1 — Examine the samples

Read every example the user has provided. If they haven't pasted examples, ask for at
least 2–3 representative messages before writing any pattern.

Look for:
- What fields are present? (amount, currency, merchant, date, balance, account, etc.)
- Is the format consistent? Or are there variations (some have balance, some don't)?
- Are there multiple languages (e.g., Thai + English in one blob)? If so, which language
  is more reliable for regex anchoring?
- What literal text reliably surrounds each field? ("spent THB", "at", "on", etc.)

## Step 2 — Identify anchor text and field boundaries

Fields sit between fixed "anchor" strings in the message. Map them:

```
"You have spent THB <amount> using UOB card <card-info> at <merchant> on <date>. Available credit: THB <balance>"
```

Note exactly what surrounds each field — including punctuation and whitespace.

## Step 3 — Build incrementally

Start with the smallest pattern that proves the anchor text matches, then extend it one
field at a time. Test each step in a Node.js one-liner:

```bash
node -e "const txt = '...paste msg here...'; console.log(/spent (?<currency>THB)/s.test(txt));"
```

Typical build order:
1. Find the first unique anchor — does it appear in the text?
2. Add the first capture group
3. Continue right, adding the next anchor + capture group
4. Stop and test when a step fails — that's where the bug is

## Step 4 — Handle invisible character surprises

Bank and app notifications frequently contain **non-breaking spaces** (U+00A0, codepoint 160)
where you'd expect a regular space (U+0020). This is the single most common reason a
pattern matches up to a word boundary but then fails right after.

If a pattern breaks at a boundary like `) at` or `card at`, print the char codes:

```bash
node -e "
const txt = '...paste msg here...';
const i = txt.indexOf('card');
if (i >= 0) {
  const chunk = txt.slice(i, i + 30);
  console.log(Array.from(chunk).map(c => c.codePointAt(0)).join(','));
}
"
```

Codepoint 160 = non-breaking space. Fix: replace the literal space in your pattern with
`\s+` (or `[\s ]+` for explicit clarity), since JavaScript's `\s` matches U+00A0.

**Other invisible gotchas to check:**
- Zero-width spaces (U+200B, codepoint 8203)
- En-dash (U+2013, 8211) vs hyphen (U+002D, 45)
- Full-width digits (U+FF10–U+FF19) instead of ASCII digits

## Step 5 — JSON and escaping

When the pattern will be passed as a **JSON string** (e.g., to an MCP tool), backslashes
must be doubled:

| In regex | In JSON string |
|----------|----------------|
| `\d`     | `\\d`          |
| `\s`     | `\\s`          |
| `\.`     | `\\.`          |
| `\n`     | `\\n`          |

**`/` does NOT need escaping** — it's only special inside JS regex literals (`/.../`),
not inside `new RegExp(pattern)`. So `[0-9]{2}/[0-9]{2}` is fine as-is.

**`\/` in JSON is just `\/`** — a forward slash. No double backslash needed.

## Step 6 — Named capture groups for `get_transactions`

When building patterns for the LINE MCP `get_transactions` tool, the group names matter:

| Group name   | Required? | Notes |
|--------------|-----------|-------|
| `currency`   | Yes       | Must be an explicit group — no fallback |
| `amount`     | Yes       | Can contain commas: `[\d,.]+` |
| `merchant`   | No        | Trim whitespace from result |
| `date`       | No        | Use `date_format` hint alongside |
| `balance`    | No        | Same numeric format as amount |
| `account`    | No        | Card number, account suffix, etc. |

The pattern is compiled as `new RegExp(pattern, 's')` — dotAll is always on, so `.`
matches `\n` and you can write one pattern for bilingual messages.

The `amount_sign` field controls sign: `"debit"` → negative, `"credit"` → positive.

## Step 7 — Validate and present the final pattern

Before presenting the final result, run one last test against each sample message:

```bash
node -e "
const pattern = 'YOUR PATTERN HERE';
const re = new RegExp(pattern, 's');
const samples = [
  '...msg 1...',
  '...msg 2...',
];
samples.forEach((s, i) => {
  const m = re.exec(s);
  console.log('msg', i, m ? JSON.stringify(m.groups) : 'NO MATCH');
});
"
```

Present the pattern as a JSON-ready string (with doubled backslashes) and explain each
named group.

## Common mistakes

- **Literal space before a word** — use `\s+` instead of ` ` when parsing bank messages
- **Greedy `.+` captures too much** — use lazy `.+?` instead
- **Pattern too greedy across newlines** — use `[^\n]+` to stop at a line break
- **Forgetting `s` flag** — when message is multi-line, `.` without `s` won't cross `\n`
- **Double-escaping in JSON** — `\\\\d` in JSON → `\\d` in string → `\d` in regex (wrong); you want `\\d` in JSON
