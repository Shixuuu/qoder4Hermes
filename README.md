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
chmod +x scripts/install.sh bin/qoder-cn.mjs
./scripts/install.sh
```

### 2. Watch the checklist

You should see green ticks:

```
✓ node           v22.x
✓ qoderclicn     /usr/bin/qoderclicn
✓ cli            ~/.local/bin/qoder-cn
✓ login          signed in
✓ api            http://127.0.0.1:8787/v1
✓ clients        Hermes + OpenCode
```

If **login** is red, a browser opens. Sign in, go back to the terminal, press **Enter**.

### 3. Use it

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `not-used` |
| Model | `qwen3.8-max` (or `qwen3.8-flash`, `efficient`) |

Hermes: `hermes model` → **qoder-cn** / **qwen3.8-max**  
OpenCode: `--model qoder-cn/qwen3.8-max`

That’s it. Leave the computer on; the API restarts itself.

---

## Commands (same idea as `grok`)

```
qoder-cn setup      # first-time walkthrough
qoder-cn doctor     # is anything broken?
qoder-cn login      # browser sign-in
qoder-cn start      # start the API
qoder-cn stop
qoder-cn status
qoder-cn models
qoder-cn wire       # rewrite Hermes / OpenCode config
qoder-cn uninstall
```

`-y` / `--yes` = no questions (for agents). `--json` = machine output.

---

## Agent setup

See [AGENTS.md](./AGENTS.md). Short version:

```bash
node bin/qoder-cn.mjs setup --yes
```

If it exits **2**, the operator must log in, then run the same command again.

---

## What this is / is not

- **Is:** local `GET /v1/models` and `POST /v1/chat/completions` (and `/chat/completions`) using the CN account already on this machine.
- **Is not:** Qoder’s official public inference API. Custom models inside Qoder IDE are the **opposite** direction (you bring keys *into* Qoder).
- **Is not:** a nested Qoder coding agent. Tools run in Hermes/OpenCode.

Paid Qoder CN plans work. Lite/Efficient are the 0x routing slots.

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

