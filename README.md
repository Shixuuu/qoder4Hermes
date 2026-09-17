# qoder4Hermes

**Use your Qoder quota from Hermes.** Free AI inference tends to be locked behind vendor harnesses and CLIs. qoder4Hermes is a start at fixing that for Qoder: it serves your Qoder account's quota as a local OpenAI-compatible endpoint that Hermes can use as a normal model provider.

The Qoder CLI stays an inference provider; Hermes stays the agent. This repo is the small local API in between, and it works without spawning `qoderclicn` / `qodercli` as the agent.

> **Status: experimental, work in progress.**
> qoder4Hermes is currently **meant for Hermes** — that is the setup that is built and tested. Other harnesses (OpenCode, Claude Code, raw HTTP clients) may work, because the endpoint is plain OpenAI-compatible, but they are **untested** here. The **CLI setup flow** (installer, wizard, service wiring) is **experimental and a work in progress** — expect rough edges. The manual route always works: run the API and point your client at `http://127.0.0.1:8787/v1`.

Unofficial. Not affiliated with Qoder / Alibaba.

---

## What you need

1. A Qoder account with quota on it: **Qoder CN**, or **Qoder International**.
2. A **Qoder token made from your Qoder profile**: sign in to your Qoder account, open the integrations page, create a personal access token (starts with `pt-…`), and paste it during setup.
   - Qoder CN: `https://qoder.cn/account/integrations`
   - Qoder International: `https://qoder.com/account/integrations`
3. Node 18+ (the installer can unpack an official Node into `~/.local` when missing).

## Quickstart (Hermes)

```bash
git clone https://github.com/Shixuuu/qoder4Hermes
cd qoder4Hermes
./scripts/install.sh --yes          # experimental — see the status note above
# non-interactive instead:
# QODERCN_PERSONAL_ACCESS_TOKEN=pt-… ./scripts/install.sh --yes
```

The installer starts the API on `http://127.0.0.1:8787/v1` and wires Hermes (`~/.hermes/config.yaml` plus any detected bot profiles). Then select it in Hermes:

```
hermes model        # pick the qoder4hermes provider → qwen3.8-max
```

Client settings, for anything configured by hand:

```
Base URL  http://127.0.0.1:8787/v1
API key   not-used
Model     qwen3.8-max   (or qwen3.8-flash, efficient, deepseek-v4-pro, glm-5.3, kimi-k3, …)
```

Hermes also accepts `http://127.0.0.1:8787` (no `/v1`). Keep the API running (`qoder4hermes status`).

---

## Human setup (copy this)

### 1. Open a terminal in this folder

```bash
cd qoder4Hermes
chmod +x scripts/install.sh bin/qoder4hermes.mjs
./scripts/install.sh
```

### 2. Walk through the wizard

Prerequisites, then sign-in (**Qoder token from your profile** is the recommended path; browser login via the official CLI is the alternative), then the local API, then whether to wire Hermes (and best-effort OpenCode).

### 3. Watch the ticks

You should see green ticks:

```
✔ node           v22.x
✔ qoderclicn     /usr/bin/qoderclicn        (only needed for browser login)
✔ cli            ~/.local/bin/qoder4hermes
✔ login          signed in
✔ api            http://127.0.0.1:8787/v1
✔ clients        Hermes
✔ profiles       Hermes bot profiles wired
```

If **login** is red, choose:

1. **Qoder token** — paste a token made from your Qoder profile at `https://qoder.cn/account/integrations`
2. **Browser** — official `qoderclicn login` (installs the Qoder CLI when missing)
3. **Qoder International** — `qoder4hermes login --region global --pat --token pt-…` with a token from `https://qoder.com/account/integrations`

Or later:

```bash
qoder4hermes login --pat
qoder4hermes login --browser
```

### 4. Use it

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `not-used` |
| Model | `qwen3.8-max` (or `qwen3.8-flash`, `efficient`) |

Hermes: `hermes model` → **qoder4hermes** → **qwen3.8-max** (mid-session: `/model custom:qoder4hermes:qwen3.8-max`).
All Qoder models are available besides the ones mentioned in the table.

---

## Commands

The command is **`qoder4hermes`**, not `qoderclicn` / `qodercli` (those are Qoder's official CLIs). Machines wired before the rename keep a working `qoder-cn-infer` shim.

```
qoder4hermes setup      # first-time walkthrough (experimental)
qoder4hermes doctor     # is anything broken?
qoder4hermes login      # token from your Qoder profile, or browser
qoder4hermes start      # start the API
qoder4hermes stop
qoder4hermes status
qoder4hermes models
qoder4hermes usage      # credits, tokens, reset window
qoder4hermes claim      # redeem Qoder promo/activity credits (the CLI's /claim)
qoder4hermes wire       # write the Hermes config block
                        #   --profiles · --profile <name> · --no-profiles
qoder4hermes telegram   # usage bot for Telegram (see below)
qoder4hermes uninstall
```

`-y` / `--yes` = no questions (for agents). `--json` = machine output. `--region <cn|global>` = which Qoder deployment to act on (default `cn`; see below).

---

## Status and scope

- **Meant for Hermes.** The Hermes wiring (`~/.hermes/config.yaml`, bot profiles, the bundled skill, `/qoder` quick commands) is what this project is built around.
- **Other harnesses may work, untested.** The endpoint is plain OpenAI-compatible, so anything that can talk to an OpenAI-style base URL can probably use it; an OpenCode example is included for reference only. Bug reports about other harnesses are welcome but not a priority.
- **The CLI setup is experimental.** The installer, wizard, and service wiring are a work in progress; commands, flags, and file layout can change between revisions. If something in the CLI setup fails, the manual route always works: run `qoder4hermes start` (or `node qoder4hermes_endpoint/server.mjs`), then point Hermes at `http://127.0.0.1:8787/v1`.

---

## Qoder International (global)

The same endpoint can serve **Qoder International** (the `qodercli` / `qoder.com` deployment) instead of Qoder CN. The regions are separate services with separate accounts — a CN token is rejected by the global token exchange and vice versa — so log into whichever region you want to serve:

```bash
qoder4hermes login --region global --pat --token pt-…   # token from https://qoder.com/account/integrations
qoder4hermes status                                     # region: global (Qoder)
qoder4hermes start                                      # (re)start the API on that region
qoder4hermes usage --region global --plain              # one-off: global account numbers
```

What `--region global` changes:

- Chat + model list: `https://api2.qoder.sh/algo/...` (the built-in default of Qoder's own global CLI; override with `QODER4HERMES_GLOBAL_INFER_HOST` or `global_infer_host` in `~/.config/qoder4hermes/config.json` — the official CLI may elect `api1`/`api2`/`api3` per network, this endpoint stays on the documented default)
- Auth / quota / claim: `https://openapi.qoder.sh`; region election host: `https://center.qoder.sh`
- Credentials: `~/.config/qoder4hermes/pat.global`, env `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT`, or the `qodercli` saved login (`~/.qoder/.auth/user`) when present
- Everything else is identical: same gateway protocol and signing, same paths, same model catalog, same local meter, same Hermes wiring

Region resolution order everywhere: `--region` flag → `QODER4HERMES_REGION` → `config.json` `region` → `cn`. Browser login for global runs `qodercli login` (installs `@qoder-ai/qodercli` when missing); the token path is simpler.

---

## Usage and limits

Same quota the Qoder CLI shows, plus a local meter of what this endpoint served.

```bash
qoder4hermes usage             # credits used / remaining, reset time, tokens
qoder4hermes usage --plain     # compact one-screen text (chat relays, cron)
qoder4hermes usage --json      # machine-readable
qoder4hermes usage --refresh   # bypass the 60s account cache
curl -s http://127.0.0.1:8787/usage   # same data from the API
```

The account side reads the CLI's own quota endpoint — `GET https://openapi.qoder.com.cn/api/v2/quota/usage` with the login token as a Bearer header — and returns credits total / used / remaining, usage percentage, `isQuotaExceeded`, the reset time (`expiresAt`), and the upgrade link. Enterprise orgs get their console link instead.

The local side is a meter the server keeps from each completion's own usage event: prompt / completion / reasoning / cached tokens and credits (the same credits Qoder bills), stored in `~/.local/state/qoder4hermes/usage.json`, rolled up per model and per day. Streamed completions also forward that event as an OpenAI `usage` chunk (`choices: []`), so OpenAI-compatible clients see token counts instead of zeros.

```json
{
  "account": { "qoderUsage": { "userType": "personal_professional_trial", "totalUsagePercentage": 0.3, "userQuota": { "total": 300, "used": 87, "remaining": 213, "unit": "credits" } } },
  "local": { "totals": { "requests": 12, "total_tokens": 45231, "credits": 0.42 } }
}
```

**Context windows.** The live model list carries Qoder's selectable context windows per model (`context_config`): 200K (Qoder's web default), 400K, and 1M. The API advertises the largest window as `context_length` on `/v1/models` — 1M for every model that offers it, 200K for MiniMax-M2.7 — and includes the full list as `context_windows`. Window choice is a client-side budgeting concern (Qoder's own CLI never sends it in the chat request), so this endpoint reports the max instead of the stale legacy `max_input_tokens` (180K/96K, which is what used to cap everything at 180K).

---

## Claim promo credits

Qoder occasionally offers claimable credits (campaigns / activities). The official CLI's `/claim` is **server-driven**: it exists only while Qoder pushes a claim definition for your account, and disappears otherwise.

This tool mirrors that behavior:

```bash
qoder4hermes claim          # checks what Qoder is offering; claims when there is something
qoder4hermes claim --json
```

It reads the same feature-gate config the CLI polls (`POST https://openapi.qoder.com.cn/api/v1/qcs/config/resolve`) plus `GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns`. When a claim definition is live it runs the same flow as the CLI: the definition's `detail` endpoints list claimable activity ids, then each id is claimed via the definition's `interaction` endpoint with `?activityId=…`. When nothing is offered, it says so instead of pretending — that is the same state in which the CLI itself has no `/claim`.

---

## Telegram usage bot

Check usage from your phone — the repo ships a tiny bot (no extra dependencies):

1. Create a bot with **@BotFather** in Telegram (`/newbot`) and copy the token.
2. Install the usage bot:

```bash
qoder4hermes telegram --tg-token <token> --install
```

Message the bot once to bind that chat, then send `/usage` (also `/status` and `/help`). The token is stored in `~/.config/qoder4hermes/telegram.json` (mode 600), the bot restarts itself, and only the bound chat is answered.

Prefer a scheduled digest? `--report` sends one push and exits, so any scheduler works:

```bash
# daily 9am credit check to the bound chat
0 9 * * *  qoder4hermes telegram --report
```

Hermes agents: copy the bundled skill — `cp -r integrations/hermes-skill/qoder-usage ~/.hermes/skills/` — and any Hermes bot (Telegram profiles included) can answer plain "how much Qoder quota is left" questions.

### Slash command in Hermes gateways (/qoder)

Any Hermes Telegram gateway (or any other platform) can expose usage as a native slash command that answers instantly, without an LLM call — add to that profile's `config.yaml` and restart the gateway:

```yaml
quick_commands:
  qoder:
    type: exec
    description: Qoder credits and served tokens
    command: qoder4hermes usage --plain
```

Then `/qoder` in Telegram replies with the credits line, reset window, and the served-token meter. Note `/usage` is already a Hermes builtin (agent token usage), so use `/qoder` (or any free name).

---

## Hermes Telegram gateways (bot profiles)

Telegram gateway bots run as Hermes **profiles** under `~/.hermes/profiles/<name>/`. `setup` and `wire` can add the qoder4hermes provider to them as well, next to the main `~/.hermes/config.yaml`:

```bash
qoder4hermes wire --profiles        # every detected profile
qoder4hermes wire --profile kgu     # one profile (repeatable)
qoder4hermes wire --no-profiles     # skip profiles entirely
```

Wiring only adds the provider block to a profile's `config.yaml`; it never changes that profile's default model or provider, and profiles without a `config.yaml` are skipped and reported. `qoder4hermes doctor` shows the wired state of each profile.

Every wired Hermes config also gets **`/qoder` and `/claim` quick commands** — `quick_commands` exec entries that run the CLI directly in the gateway, so they answer instantly and without an LLM turn:

```yaml
quick_commands:
  qoder:
    type: exec
    command: "$HOME/.local/bin/qoder4hermes usage --refresh"
  claim:
    type: exec
    command: "$HOME/.local/bin/qoder4hermes claim"
```

Restart the gateway once after wiring to load them.

To actually run a bot on your Qoder quota, switch that profile's model and restart its gateway:

```bash
hermes -p kgu model       # pick the qoder4hermes provider → qwen3.8-max
```

Keep `qoder4hermes start` running — profiles point at `http://127.0.0.1:8787/v1` like everything else.

---

## Other harnesses (untested)

The endpoint is a plain OpenAI-compatible surface, so any harness that accepts a custom base URL can probably use it. Hermes is the tested path; the config below is provided for reference and is **not tested**.

OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "qoder4hermes/qwen3.8-max",
  "provider": {
    "qoder4hermes": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qoder (local endpoint)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "not-used"
      },
      "models": {
        "qwen3.8-max": { "name": "Qwen3.8-Max" }
      }
    }
  }
}
```

Anything else: base URL `http://127.0.0.1:8787/v1`, API key `not-used` (a placeholder, not a secret).

---

## Regions

- `cn` (default): Qoder CN — CLI `qoderclicn`, hosts `gateway.qoder.com.cn` / `openapi.qoder.com.cn`, token from `https://qoder.cn/account/integrations`, stored in `~/.config/qoder4hermes/pat`, env `QODERCN_PERSONAL_ACCESS_TOKEN`.
- `global`: Qoder International — CLI `qodercli`, hosts `api2.qoder.sh` (inference) / `center.qoder.sh` / `openapi.qoder.sh`, token from `https://qoder.com/account/integrations`, stored in `~/.config/qoder4hermes/pat.global`, env `QODER_PERSONAL_ACCESS_TOKEN`.
- Resolution order: `--region` flag → `QODER4HERMES_REGION` → `config.json` `region` → `cn`. `setup` and `login` persist it; the server reads it at startup (the systemd unit sets `QODER4HERMES_REGION`; the nohup fallback passes it too).
- The two regions are separate services with separate accounts: a CN token is rejected by the global token exchange (HTTP 400) and vice versa.

## Agent setup

See [AGENTS.md](./AGENTS.md). Short version:

```bash
node bin/qoder4hermes.mjs setup --yes                                  # Qoder CN (default)
QODER_PERSONAL_ACCESS_TOKEN=pt-… node bin/qoder4hermes.mjs setup --yes --region global
```

If it exits **2**, the operator must sign in (`qoder4hermes login --pat --token pt-…`, add `--region global` for Qoder International), then run the same command again. `setup --json` reports the active `region`; `doctor --json` and `status --json` do too.

---

## License

MIT. Unofficial.

---

## Notes (for tools & researchers)

Qoder does not publish a public OpenAI-compatible inference API. There is no supported `https://api.qoder.com.cn/v1/chat/completions`. Official custom models support is BYOK into Qoder (the opposite direction). Cloud Agents at `https://api.qoder.com.cn/api/v1/cloud` is a hosted sandbox, not raw completions.

This repo is a local OpenAI-compatible HTTP facade for `GET /v1/models` and `POST /v1/chat/completions` without spawning `qoderclicn` / `qodercli` as the agent. Auth is the `qoderclicn` login, `QODERCN_PERSONAL_ACCESS_TOKEN`, or `QODER_PAT` (a Qoder token made from your Qoder profile). CN: `qoder.com.cn`, `api.qoder.com.cn`, `gateway.qoder.com.cn`. Global: `qoder.com`, `api.qoder.com` — the `--region global` path talks to the global deployment directly (`api2.qoder.sh` inference default, `center.qoder.sh`, `openapi.qoder.sh`), with `QODER_PERSONAL_ACCESS_TOKEN` or the `qodercli` login.

Hermes config (manual route; `qoder4hermes wire` writes this for you):

```yaml
model:
  default: qwen3.8-max
  provider: custom:qoder4hermes

providers:
  qoder4hermes:
    name: Qoder (local endpoint)
    base_url: http://127.0.0.1:8787/v1
    api_key: not-used
    transport: chat_completions
    discover_models: true
    models:
      qwen3.8-max: {}
      Qwen3.8-Max: {}
```

Machines wired before the rename may still carry the provider block under an older key (`qoder-cn-infer`); both keys resolve to the same local endpoint.
