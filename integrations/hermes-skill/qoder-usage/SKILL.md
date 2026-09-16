---
name: qoder-usage
description: "Use when asked about Qoder CN credits, usage, or quota."
version: 0.1.0
author: Shixu (Shixuuu), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    editorial_name: Qoder CN Usage
    editorial_description: Check Qoder CN account credits, reset window, and served tokens through the qoder-cn-infer facade.
    tags: [qoder, usage, credits, quota]
    related_skills: []
    requires_tools: [terminal]
---

# Qoder CN Usage

Report Qoder CN account usage (credits, reset window) and the local token/credit meter kept by the qoder-cn-infer facade at `http://127.0.0.1:8787/v1`. Works from any chat, including Telegram.

## When to Use

- User asks about Qoder CN usage, credits, remaining quota, tokens served, or when the quota resets
- User wants a usage summary relayed to a chat
- Don't use for: Qoder IDE features, or token counting unrelated to the facade

## Prerequisites

- `qoder-cn-infer` on PATH (`~/.local/bin/qoder-cn-infer`) with a stored login
- Missing? Install from the qoder-cn-infer repo (`./scripts/install.sh --yes`), then `qoder-cn-infer start`

## How to Run

```bash
qoder-cn-infer usage --json
```

If the API is down, the same command still returns the local meter (and `--local` skips the account call explicitly).

## What to Report

- Credits used / total with percentage, credits remaining, reset time (`expiresAt`)
- Local meter: requests, tokens (in / out / thinking / cached), credits served, today's totals
- `account_error` mentioning login means the user should run `qoder-cn-infer login`

## Pitfalls

- Account numbers are credits, not tokens; the token breakdown is the local meter
- The account figure is cached up to 60s: add `--refresh` for live numbers
- `~/.local/state/qoder-cn-infer/usage.json` holds the meter when the CLI is unavailable

## Verification

- `qoder-cn-infer usage --json` exits 0 and shows `account.qoderUsage` or an explicit `account_error`
- Totals increase after any chat routed through the facade
