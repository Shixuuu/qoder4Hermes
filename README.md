# qoder-cn-infer
Free AI inference tends to be locked behind vendor harnesses and clis. This project is a start to fix that . It lets you Use **your Qoder CN quota** from Hermes, OpenCode, or any OpenAI-compatible client.

The Qoder CLI stays a **inference provider** while Hermes / OpenCode or any third party harness stay the **actual agent environment**. This repo is a small local API in between which serves as a custom endpoint

Unofficial. Not affiliated with Qoder / Alibaba.

---

## Human setup (copy this)

You need a Qoder CN account. Everything else is automatic.

### 1. Open a terminal in this folder

```bash
cd qoder-cn-infer
chmod +x scripts/install.sh bin/qoder-cn-infer.mjs
./scripts/install.sh
```

### 2. Walk through the wizard

 prerequisites, then a radio list for **Browser vs PAT**, then the local API, then whether to wire Hermes / OpenCode.

### 3. Watch the ticks

You should see green ticks:

```
✓ node           v22.x
✓ qoderclicn     /usr/bin/qoderclicn
✓ cli            ~/.local/bin/qoder-cn-infer
✓ login          signed in
✓ api            http://127.0.0.1:8787/v1
✓ clients        Hermes + OpenCode
✓ profiles       Hermes bot profiles wired
```

If **login** is red, choose:

1. **Browser** — official `qoderclicn login` (recommended)
2. **PAT** — paste a token from [qoder.cn/account/integrations](https://qoder.cn/account/integrations)

Or later:

```bash
qoder-cn-infer login --browser
qoder-cn-infer login --pat
```

### 4. Use it

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `not-used` |
| Model | `qwen3.8-max` (or `qwen3.8-flash`, `efficient`) |

Hermes: `hermes model` → **qoder-cn-infer** / **qwen3.8-max**  
OpenCode: `--model qoder-cn-infer/qwen3.8-max`
All models of Qoder are available besides the ones mentioned in the table

---

## Commands

The command is **`qoder-cn-infer`**, not `qodercn` / `qoderclicn` (those are the official Qoder CN CLI).

```
qoder-cn-infer setup      # first-time walkthrough
qoder-cn-infer doctor     # is anything broken?
qoder-cn-infer login      # browser sign-in (runs qoderclicn login)
qoder-cn-infer start      # start the API
qoder-cn-infer stop
qoder-cn-infer status
qoder-cn-infer models
qoder-cn-infer usage      # credits, tokens, reset window
qoder-cn-infer wire       # rewrite Hermes / OpenCode config
                          #   --profiles · --profile <name> · --no-profiles
qoder-cn-infer uninstall
```

`-y` / `--yes` = no questions (for agents). `--json` = machine output.

---

## Usage and limits

Same quota the Qoder CLI shows, plus a local meter of what this facade served.

```bash
qoder-cn-infer usage             # credits used / remaining, reset time, tokens
qoder-cn-infer usage --json      # machine-readable
qoder-cn-infer usage --refresh   # bypass the 60s account cache
curl -s http://127.0.0.1:8787/usage   # same data from the API
```

The account side reads the CLI's own quota endpoint — `GET https://openapi.qoder.com.cn/api/v2/quota/usage` with the login token as a Bearer header — and returns credits total / used / remaining, usage percentage, `isQuotaExceeded`, the reset time (`expiresAt`), and the upgrade link. Enterprise orgs get their console link instead.

The local side is a meter the server keeps from each completion's own usage event: prompt / completion / reasoning / cached tokens and credits (the same credits Qoder bills), stored in `~/.local/state/qoder-cn-infer/usage.json`, rolled up per model and per day. Streamed completions also forward that event as an OpenAI `usage` chunk (`choices: []`), so OpenAI-compatible clients see token counts instead of zeros.

```json
{
  "account": { "qoderUsage": { "userType": "personal_professional_trial", "totalUsagePercentage": 0.3, "userQuota": { "total": 300, "used": 87, "remaining": 213, "unit": "credits" } } },
  "local": { "totals": { "requests": 12, "total_tokens": 45231, "credits": 0.42 } }
}
```

---

## Hermes Telegram gateways (bot profiles)

Telegram gateway bots run as Hermes **profiles** under `~/.hermes/profiles/<name>/`. `setup` and `wire` can add the qoder-cn-infer provider to them as well, next to the main `~/.hermes/config.yaml`:

```bash
qoder-cn-infer wire --profiles        # every detected profile
qoder-cn-infer wire --profile kgu     # one profile (repeatable)
qoder-cn-infer wire --no-profiles     # skip profiles entirely
```

Wiring only adds the provider block to a profile's `config.yaml`; it never changes that profile's default model or provider, and profiles without a `config.yaml` are skipped and reported. `qoder-cn-infer doctor` shows the wired state of each profile.

To actually run a bot on your Qoder quota, switch that profile's model and restart its gateway:

```bash
hermes -p kgu model       # pick qoder-cn-infer / qwen3.8-max
```

Keep `qoder-cn-infer start` running — profiles point at `http://127.0.0.1:8787/v1` like everything else.

---

## Agent setup

See [AGENTS.md](./AGENTS.md). Short version:

```bash
node bin/qoder-cn-infer.mjs setup --yes
```

If it exits **2**, the operator must log in, then run the same command again.

---

---

## License

MIT. Unofficial.

---

## Notes (for tools & researchers)

Qoder CN does **not** publish a public OpenAI-compatible inference API. There is no supported `https://api.qoder.com.cn/v1/chat/completions`. Official custom models is BYOK **into** Qoder (the **opposite direction**). Cloud Agents at `https://api.qoder.com.cn/api/v1/cloud` is a hosted sandbox, not raw completions.

This repo is a **local OpenAI-compatible HTTP** facade for `GET /v1/models` and `POST /v1/chat/completions` **without spawning** `qoderclicn` / `qodercn` / `qodercli` as the agent. Auth is `qoderclicn` login, `QODERCN_PERSONAL_ACCESS_TOKEN`, or `QODER_PAT`. CN: `qoder.com.cn`, `qoderclicn`, `api.qoder.com.cn`, `gateway.qoder.com.cn`. Global: `qoder.com`, `qodercli`, `api.qoder.com`.

Hermes:

```yaml
model:
  default: qwen3.8-max
  provider: custom:qoder-cn-local

providers:
  qoder-cn-local:
    name: Qoder CN (inference facade)
    base_url: http://127.0.0.1:8787/v1
    api_key: not-used
    transport: chat_completions
    models:
      qwen3.8-max: {}
      Qwen3.8-Max: {}
```

OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "qoder-cn-local/qwen3.8-max",
  "provider": {
    "qoder-cn-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qoder CN (inference facade)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "not-used"
      },
      "models": {
        "qwen3.8-max": {
          "name": "Qwen3.8-Max"
        }
      }
    }
  }
}
```

