---
name: qoder-usage
description: "Use when asked about Qoder credits, usage, or quota through the qoder4Hermes local endpoint."
version: 0.2.0
author: Shixu (Shixuuu), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    editorial_name: Qoder Usage
    editorial_description: Check Qoder account credits, reset window, and served tokens through the qoder4Hermes local endpoint.
    tags: [qoder, usage, credits, quota]
    related_skills: []
    requires_tools: [terminal]
---

# Qoder Usage

Report Qoder account usage (credits, reset window) and the local token/credit meter kept by the qoder4Hermes endpoint at `http://127.0.0.1:8787/v1`. Works from any chat, including Telegram.

## When to Use

- User asks about Qoder usage, credits, remaining quota, tokens served, or when the quota resets
- User wants a usage summary relayed to a chat
- Don't use for: Qoder IDE features, or token counting unrelated to the local endpoint

## Prerequisites

- `qoder4hermes` on PATH (`~/.local/bin/qoder4hermes`) with a stored Qoder token (created from the user's Qoder profile). On machines wired before the rename, the legacy `qoder-cn-infer` shim still works.
- Missing? Install from the qoder4Hermes repo (`./scripts/install.sh --yes`, experimental), then `qoder4hermes start`

## How to Run

```bash
qoder4hermes usage --json
```

If the API is down, the same command still returns the local meter (and `--local` skips the account call explicitly).

## What to Report

- Credits used / total with percentage, credits remaining, reset time (`expiresAt`)
- Local meter: requests, tokens (in / out / thinking / cached), credits served, today's totals
- `account_error` mentioning login means the user should run `qoder4hermes login`

## Pitfalls

- Account numbers are credits, not tokens; the token breakdown is the local meter
- The account figure is cached up to 60s: add `--refresh` for live numbers
- `~/.local/state/qoder4hermes/usage.json` holds the meter (machines from before the rename may still write `~/.local/state/qoder-cn-infer/usage.json`)

## Verification

- `qoder4hermes usage --json` exits 0 and shows `account.qoderUsage` or an explicit `account_error`
- Totals increase after any chat routed through the endpoint
