# qoder-cn-infer
Free AI inference tends to be locked behind vendor harnesses and clis. This project is a start to fix that . It lets you Use **your Qoder CN quota** from Hermes, OpenCode, or any OpenAI-compatible client.

The Qoder CLI stays a **inference provider** while Hermes / OpenCode or any third party harness stay the **actual agent environment**. This repo is a small local API in between which serves as a custom endpoint

Unofficial. Not affiliated with Qoder / Alibaba.

---

## Quickstart for any agent (any machine)

One endpoint, any harness: Hermes, OpenCode, Claude Code, custom scripts, raw HTTP.

```bash
git clone https://github.com/Shixuuu/qoder-cn-infer
cd qoder-cn-infer
QODERCN_PERSONAL_ACCESS_TOKEN=pt-… ./scripts/install.sh --yes   # omitting the env var runs the login wizard
```

Setup unpacks Node if missing, starts the API on `http://127.0.0.1:8787/v1`, and only wires the clients it detects (Hermes / OpenCode). Anything else just points at the URL:

```
Base URL  http://127.0.0.1:8787/v1
API key   not-used
Model     qwen3.8-max  (or qwen3.8-flash, efficient, deepseek-v4-pro, glm-5.3, kimi-k3, …)
```

`qoder-cn-infer wire` forces Hermes + OpenCode config writes even when detection is inconclusive.

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
3. **Global (Qoder International)** — `qoder-cn-infer login --region global --pat` with a token from [qoder.com/account/integrations](https://qoder.com/account/integrations)

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
qoder-cn-infer claim      # redeem Qoder promo/activity credits (the CLI's /claim)
qoder-cn-infer wire       # rewrite Hermes / OpenCode config
                          #   --profiles · --profile <name> · --no-profiles
qoder-cn-infer telegram   # usage bot for Telegram (see below)
qoder-cn-infer uninstall
```

`-y` / `--yes` = no questions (for agents). `--json` = machine output. `--region <cn|global>` = which Qoder deployment to act on (default `cn`; see below).

---

## Qoder International (global)

The same facade can serve **Qoder International** (the `qodercli` / `qoder.com` deployment) instead of Qoder CN. The regions are separate services with separate accounts — a CN PAT is rejected by the global token exchange and vice versa — so log into whichever region you want to serve:

```bash
qoder-cn-infer login --region global --pat --token pt-…   # token from https://qoder.com/account/integrations
qoder-cn-infer status                                     # region: global (Qoder)
qoder-cn-infer start                                      # (re)start the API on that region
qoder-cn-infer usage --region global --plain              # one-off: global account numbers
```

What `--region global` changes:

- Chat + model list: `https://api2.qoder.sh/algo/...` (the built-in default of Qoder's own global CLI; override with `QODER_CN_INFER_GLOBAL_INFER_HOST` or `global_infer_host` in `~/.config/qoder-cn-infer/config.json` — the official CLI may elect `api1`/`api2`/`api3` per network, this facade stays on the documented default)
- Auth / quota / claim: `https://openapi.qoder.sh`; region election host: `https://center.qoder.sh`
- Credentials: `~/.config/qoder-cn-infer/pat.global`, env `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT`, or the `qodercli` saved login (`~/.qoder/.auth/user`) when present
- Everything else is identical: same gateway protocol and COSY signing, same paths, same model catalog, same local meter, same Hermes / OpenCode wiring

Region resolution order everywhere: `--region` flag → `QODER_CN_INFER_REGION` → `config.json` `region` → `cn`. Browser login for global runs `qodercli login` (installs `@qoder-ai/qodercli` when missing); the PAT path is simpler.

---

## Usage and limits

Same quota the Qoder CLI shows, plus a local meter of what this facade served.

```bash
qoder-cn-infer usage             # credits used / remaining, reset time, tokens
qoder-cn-infer usage --plain     # compact one-screen text (chat relays, cron)
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

**Context windows.** The live model list carries Qoder's selectable context windows per model (`context_config`): 200K (Qoder's web default), 400K, and 1M. The API advertises the largest window as `context_length` on `/v1/models` — 1M for every model that offers it, 200K for MiniMax-M2.7 — and includes the full list as `context_windows`. Window choice is a client-side budgeting concern (Qoder's own CLI never sends it in the chat request), so the facade reports the max instead of the stale legacy `max_input_tokens` (180K/96K, which is what used to cap everything at 180K).

---

## Claim promo credits

Qoder occasionally offers claimable credits (campaigns / activities). The official CLI's `/claim` is **server-driven**: it exists only while Qoder pushes a claim definition for your account, and disappears otherwise.

This tool mirrors that behavior:

```bash
qoder-cn-infer claim          # checks what Qoder is offering; claims when there is something
qoder-cn-infer claim --json
```

It reads the same feature-gate config the CLI polls (`POST https://openapi.qoder.com.cn/api/v1/qcs/config/resolve`) plus `GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns`. When a claim definition is live it runs the same flow as the CLI: the definition's `detail` endpoints list claimable activity ids, then each id is claimed via the definition's `interaction` endpoint with `?activityId=…`. When nothing is offered, it says so instead of pretending — that is the same state in which the CLI itself has no `/claim`.

---

## Telegram usage bot

Check usage from your phone — the repo ships a tiny bot (no extra dependencies):

1. Create a bot with **@BotFather** in Telegram (`/newbot`) and copy the token.
2. Install the usage bot:

```bash
qoder-cn-infer telegram --tg-token <token> --install
```

Message the bot once to bind that chat, then send `/usage` (also `/status` and `/help`). The token is stored in `~/.config/qoder-cn-infer/telegram.json` (mode 600), the bot restarts itself, and only the bound chat is answered.

Prefer a scheduled digest? `--report` sends one push and exits, so any scheduler works:

```bash
# daily 9am credit check to the bound chat
0 9 * * *  qoder-cn-infer telegram --report
```

Hermes agents: copy the bundled skill — `cp -r integrations/hermes-skill/qoder-usage ~/.hermes/skills/` — and any Hermes bot (Telegram profiles included) can answer plain "how much Qoder quota is left" questions.

### Slash command in Hermes gateways (/qoder)

Any Hermes Telegram gateway (or any other platform) can expose usage as a native slash command that answers instantly, without an LLM call — add to that profile's `config.yaml` and restart the gateway:

```yaml
quick_commands:
  qoder:
    type: exec
    description: Qoder CN credits and served tokens
    command: qoder-cn-infer usage --plain
```

Then `/qoder` in Telegram replies with the credits line, reset window, and the served-token meter. Note `/usage` is already a Hermes builtin (agent token usage), so use `/qoder` (or any free name).

---

## Hermes Telegram gateways (bot profiles)

Telegram gateway bots run as Hermes **profiles** under `~/.hermes/profiles/<name>/`. `setup` and `wire` can add the qoder-cn-infer provider to them as well, next to the main `~/.hermes/config.yaml`:

```bash
qoder-cn-infer wire --profiles        # every detected profile
qoder-cn-infer wire --profile kgu     # one profile (repeatable)
qoder-cn-infer wire --no-profiles     # skip profiles entirely
```

Wiring only adds the provider block to a profile's `config.yaml`; it never changes that profile's default model or provider, and profiles without a `config.yaml` are skipped and reported. `qoder-cn-infer doctor` shows the wired state of each profile.

Every wired Hermes config also gets **`/qoder` and `/claim` quick commands** — `quick_commands` exec entries that run the CLI directly in the gateway, so they answer instantly and without an LLM turn:

```yaml
quick_commands:
  qoder:
    type: exec
    command: "$HOME/.local/bin/qoder-cn-infer usage --refresh"
  claim:
    type: exec
    command: "$HOME/.local/bin/qoder-cn-infer claim"
```

Restart the gateway once after wiring to load them.

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

This repo is a **local OpenAI-compatible HTTP** facade for `GET /v1/models` and `POST /v1/chat/completions` **without spawning** `qoderclicn` / `qodercn` / `qodercli` as the agent. Auth is `qoderclicn` login, `QODERCN_PERSONAL_ACCESS_TOKEN`, or `QODER_PAT`. CN: `qoder.com.cn`, `qoderclicn`, `api.qoder.com.cn`, `gateway.qoder.com.cn`. Global: `qoder.com`, `qodercli`, `api.qoder.com` — the facade's `--region global` talks to the global deployment directly (`api2.qoder.sh` inference default, `center.qoder.sh`, `openapi.qoder.sh`), with `QODER_PERSONAL_ACCESS_TOKEN` or the `qodercli` login.

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

