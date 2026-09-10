# Use Qoder CN monthly quota from Hermes Agent, OpenCode, and other coding agents

Qoder CN does **not** publish a public OpenAI-compatible inference API (`/v1/chat/completions`) for its bundled models. There is no supported drop-in provider URL such as `https://api.qoder.com.cn/v1/chat/completions` that Hermes Agent or OpenCode can set as `base_url` / `baseURL`.

Official **自定义模型 / custom models** is BYOK **into** Qoder (you paste a DeepSeek / Kimi / MiniMax / Bailian key *into* Qoder CN). That is the **opposite direction** of this goal, which is to spend *Qoder CN* credits from an external coding agent.

The working method is a **local OpenAI-compatible HTTP bridge** authenticated with **your own Qoder CN account** (a PAT from the official CN integrations page, or `qoderclicn login`). The bridge exposes at least `GET /v1/models` and `POST /v1/chat/completions` on loopback. Hermes Agent, OpenCode, and any other OpenAI-base-url client then use that local URL as a custom provider and consume the account’s Qoder CN credits / free monthly quota.

This is **unofficial** and unsupported. Qoder does not document Hermes or OpenCode as first-party clients. Routing CN monthly credits through a third-party agent may violate Qoder terms; treat it as a personal compatibility experiment, not an endorsed integration.

## Official CN APIs (what actually exists)

Fetched from `https://docs.qoder.cn/llms.txt` and the linked pages on 2026-09-10.

| Surface | What it is | What it is not |
| --- | --- | --- |
| **自定义模型 / custom models** | BYOK **into** Qoder CN. IDE: [自定义模型](https://docs.qoder.cn/user-guide/custom-model.md) / [Qoder 自定义模型](https://docs.qoder.cn/qoder/custom-models.md). CLI: [CLI 自定义模型](https://docs.qoder.cn/cli/custom-models.md) via `/model` → Custom. Fees settle on the *third-party* API account and **do not** use Qoder CN credits. | Not a way to export Qoder-bundled Qwen/GLM/Kimi as an OpenAI endpoint. |
| **Cloud Agents API** | Hosted agent sessions in a cloud sandbox. Gateway: `https://api.qoder.com.cn/api/v1/cloud` (Managed) and `https://api.qoder.com.cn/api/v1/forward` (Forward). Auth: `Authorization: Bearer <PAT or SAT>`. Connectivity check is `GET /api/v1/cloud/agents`, not chat completions. Model list for *agents* is `GET https://api.qoder.com.cn/api/v1/cloud/models`. | Not raw LLM inference. Do not treat Cloud Agents sessions as `/v1/chat/completions`. |
| **Qoder Agent SDK** | Embeds the `qoderclicn` **agent runtime** (tools, files, permissions) in TypeScript/Python. PAT env: `QODERCN_PERSONAL_ACCESS_TOKEN`. | Nested coding agent, not an OpenAI-compatible inference provider. |
| **Qoder CLI CN** | `qoderclicn` / `qodercn`. Login via browser or PAT. Bundled models (e.g. `Qwen3.8-Max`) consume CN credits. | Terminal agent. `qoderclicn -p` is still an agent loop, not a chat-completions server. |

Documented public CN HTTP APIs stop at Cloud Agents (and enterprise OpenAPI for members/usage). They do not include a public OpenAI `POST /v1/chat/completions` for bundled models.

## Qoder CN vs global Qoder

Use the **CN stack** so **CN quota** is what gets billed. CN and global accounts, tokens, and hosts are not interchangeable.

| | **Qoder CN** (use this) | **Global Qoder** (wrong quota) |
| --- | --- | --- |
| Site | `qoder.com.cn` (account pages also at `qoder.cn`) | `qoder.com` |
| CLI binary | `qoderclicn` (`qodercn` alias), npm `@qodercn-ai/qoderclicn` | `qodercli`, npm `@qoder-ai/qodercli` |
| CLI config dir | `~/.qoder-cn` | `~/.qoder` |
| CLI / SDK PAT env | `QODERCN_PERSONAL_ACCESS_TOKEN` | `QODER_PERSONAL_ACCESS_TOKEN` |
| PAT mint (CLI/SDK) | `https://qoder.cn/account/integrations` (bridges also cite `https://qoder.com.cn/account/integrations`) | `https://qoder.com/account/integrations` |
| Cloud Agents host | `api.qoder.com.cn` | `api.qoder.com` |
| Cloud Agents PAT env | `QODER_PAT` (Bearer on `https://api.qoder.com.cn`) | `QODER_PAT` (Bearer on `https://api.qoder.com`) |
| OpenAPI host | `openapi.qoder.com.cn` | `openapi.qoder.sh` |
| Docs | `https://docs.qoder.cn` | `https://docs.qoder.com` |

If a bridge’s `backend` / `CLI_BACKEND` is `global`, or you run `qodercli` instead of `qoderclicn`, you are on global quota.

## Working method: local OpenAI-compatible HTTP bridge

```text
Hermes / OpenCode / any OpenAI client
        |  base_url http://127.0.0.1:<port>/v1
        |  api_key  = local placeholder (not the Qoder PAT)
        v
Local bridge   GET /v1/models
               POST /v1/chat/completions
        |  your Qoder CN login (PAT or qoderclicn)
        v
Qoder CN model service  →  CN credits / monthly quota
```

1. Create a CN PAT at [Qoder Account Integrations](https://qoder.cn/account/integrations) (or console **Settings → personal access tokens**), **or** run `qoderclicn login`.
2. Put the PAT only on the bridge: `QODERCN_PERSONAL_ACCESS_TOKEN` (CLI-style bridges) and/or `QODER_PAT` when a bridge talks to `api.qoder.com.cn`. Do **not** paste the PAT into Hermes or OpenCode.
3. Start a CN-capable local bridge (listen on `127.0.0.1` only).
4. Point the coding agent at `http://127.0.0.1:<port>/v1` with a placeholder API key and a real CN model id (`qwen3.8-max` / `Qwen3.8-Max`; confirm with `GET /v1/models`).

Prefer this chat-completions HTTP surface over shelling the coding agent out to `qoderclicn -p`. The CLI print mode is a nested agent (tools, extra prompt, extra credits), not a raw inference provider.

## Existing CN-capable bridges

Do not reverse-engineer Qoder COSY/signing internals. Use a maintained local bridge.

### `lininn/qorder-proxy` (CN backend)

- Repo: `https://github.com/lininn/qorder-proxy`
- Backend: `cn` → `qoderclicn` → `qoder.com.cn` (default). `global` would hit `qodercli` / `qoder.com` — do not use that for CN quota.
- Auth env: `QODERCN_PERSONAL_ACCESS_TOKEN` (or `qorder-proxy config set token …` / `--token`). PAT page: `https://qoder.com.cn/account/integrations`.
- Listen URL: `http://127.0.0.1:3000/v1` (`GET /v1/models`, `POST /v1/chat/completions`).
- Client API key: placeholder `not-used` (do not put the Qoder PAT in the client).

```bash
git clone https://github.com/lininn/qorder-proxy.git
cd qorder-proxy/qoder-proxy
npm install && npm link
export QODERCN_PERSONAL_ACCESS_TOKEN="pt-your-cn-pat"
qorder-proxy config set backend cn
qorder-proxy config set port 3000
qorder-proxy start
curl -sS http://127.0.0.1:3000/v1/models
```

### `caigee-cmd/cli2api` (Qoder 国内版)

- Repo: `https://github.com/caigee-cmd/cli2api`
- Provider: **Qoder 国内版** (plus international Qoder, WorkBuddy, Trae — pick CN).
- Auth: browser device-flow or PAT on the CN account, configured in the local console. Persistent per-account runtime rather than a fresh `qoderclicn` process per HTTP request.
- Listen URL: `http://127.0.0.1:3010/v1` (`GET /v1/models`, `POST /v1/chat/completions`).
- Client API key: the key printed on first start (still not the Qoder PAT).

```bash
git clone https://github.com/caigee-cmd/cli2api.git
cd cli2api
./scripts/start.sh
# open http://127.0.0.1:3010 → Accounts → add Qoder 国内版
```

Hermes/OpenCode `baseURL` becomes `http://127.0.0.1:3010/v1` if you use this bridge instead of port 3000.

### Also CN-capable

`avaritiachaos/qoder-proxy` is the same CN CLI-adapter pattern (`CLI_BACKEND=cn`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `http://127.0.0.1:3000/v1`, models include `qwen3.8-max`). Same warning: unofficial, loopback only.

CLI-spawn bridges still wrap `qoderclicn` (nested agent per request, higher latency). They are acceptable **because** they speak OpenAI HTTP to the coding agent. Do not skip the bridge and call `qoderclicn -p` from Hermes/OpenCode as if it were an inference backend.

## Hermes Agent custom provider

Hermes has no first-party `qoder-cn` plugin. Use a named custom provider. Current Hermes docs (`providers:` dict in `~/.hermes/config.yaml`) accept `base_url` as an alias of `api`, plus `api_key` and `models`.

Merge `examples/hermes-config.yaml`:

```yaml
model:
  default: qwen3.8-max
  provider: custom:qoder-cn-local

providers:
  qoder-cn-local:
    name: Qoder CN (local bridge)
    base_url: http://127.0.0.1:3000/v1
    api_key: not-used
    transport: chat_completions
    models:
      qwen3.8-max: {}
      Qwen3.8-Max: {}
```

Interactive equivalent: `hermes model` → Custom endpoint → base URL `http://127.0.0.1:3000/v1`, placeholder key, model `qwen3.8-max`.

If the bridge is cli2api, change `base_url` to `http://127.0.0.1:3010/v1` and `api_key` to the bridge-generated key.

## OpenCode custom provider

OpenCode has no first-party `qoder-cn` plugin. Add a `provider` entry with npm `@ai-sdk/openai-compatible` (chat-completions dialect), `options.baseURL`, `options.apiKey`, and select the model as `providerName/modelKey`.

Project `opencode.json` or `~/.config/opencode/opencode.json` — same body as `examples/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "qoder-cn-local/qwen3.8-max",
  "provider": {
    "qoder-cn-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Qoder CN (local bridge)",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "not-used"
      },
      "models": {
        "qwen3.8-max": {
          "name": "Qwen3.8-Max"
        },
        "Qwen3.8-Max": {
          "name": "Qwen3.8-Max (display id)"
        }
      }
    }
  }
}
```

Run with `--model qoder-cn-local/qwen3.8-max`. Official CN CLI documents the display name `Qwen3.8-Max`; bridges usually register the lowercase id `qwen3.8-max`. `GET /v1/models` is authoritative for the running bridge.

## Other coding agents

Any client that accepts an OpenAI-compatible `base_url` / `baseURL` ending in `/v1` can use the same local bridge (Cline, Continue, Codex with `wire_api = chat`, etc.). Hermes and OpenCode are the required examples; there is no first-party Qoder plugin to install inside those products.

## What not to do

- Do not set Hermes/OpenCode `base_url` to `https://api.qoder.com.cn` or invent `https://api.qoder.com.cn/v1/chat/completions`.
- Do not use Cloud Agents `POST /api/v1/cloud/sessions` as a chat-completions stand-in.
- Do not configure official 自定义模型 and expect that to *export* Qoder quota.
- Do not put `QODERCN_PERSONAL_ACCESS_TOKEN` / `QODER_PAT` in the coding-agent config; keep them on the bridge.
- Do not bind the bridge to `0.0.0.0` or share one PAT across people.
- Do not implement a new COSY-signed client; existing bridges already wrap the CN CLI or a maintained runtime.

## Check this repo

```bash
python3 -m qoder_cn_endpoint
python3 -m unittest discover -s tests -v
```
