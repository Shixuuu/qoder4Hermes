# Agent install (no human in the loop except Qoder login)

This repo is a **local OpenAI-compatible API** for the operator’s **own Qoder CN** account. It does not spawn `qoderclicn` as an agent. Hermes / OpenCode remain the harness.

## One command

From a clone (works on a private repo the agent can already `git clone`):

```bash
cd qoder-cn-infer
chmod +x scripts/install.sh
./scripts/install.sh --yes
```

Or, if `node` is already on PATH:

```bash
node bin/qoder-cn-infer.mjs setup --yes
```

Exit codes:

| code | meaning |
| --- | --- |
| 0 | API healthy at `http://127.0.0.1:8787/v1` |
| 1 | install/start failed (see stderr or `--json`) |
| 2 | **login missing** — operator must run `qoderclicn login` or set `QODERCN_PERSONAL_ACCESS_TOKEN` / `QODER_PAT`, then re-run `setup --yes` |

`--yes` / `QODER_CN_YES=1` never waits for Enter and never opens a blocking TTY prompt.

Machine-readable:

```bash
node bin/qoder-cn-infer.mjs setup --yes --json
node bin/qoder-cn-infer.mjs doctor --json
node bin/qoder-cn-infer.mjs status --json
```

## What setup does automatically

- Requires Node 18+ (already present, or `scripts/install.sh` unpacks official Node into `~/.local`)
- `npm install -g @qodercn-ai/qoderclicn` if `qoderclicn` is missing
- Symlinks `~/.local/bin/qoder-cn-infer` (not `qodercn` / `qoderclicn`)
- Starts a user systemd service when available, otherwise a detached Node process
- Writes Hermes (`~/.hermes/config.yaml`) and OpenCode (`~/.config/opencode/opencode.json`) provider blocks

## What it will not do

- Create a Qoder account
- Complete browser login without the operator
- Put the Qoder PAT into Hermes/OpenCode (placeholder key `not-used` only)

## Client settings after success

```
Base URL:  http://127.0.0.1:8787/v1
API key:   not-used
Model:     qwen3.8-max
```

Hermes also accepts `http://127.0.0.1:8787` (no `/v1`). Keep the API running (`qoder-cn-infer status`).
