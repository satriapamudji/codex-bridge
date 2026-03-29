# codex-bridge

Local proxy that routes OpenAI Responses API requests through your Codex/ChatGPT subscription. Zero dependencies — just Node.js.

**What it does:** Reads your Codex CLI OAuth tokens from `~/.codex/auth.json`, auto-refreshes when expired, and forwards requests to `chatgpt.com/backend-api/codex/responses` with the correct headers. Any tool that speaks the OpenAI Responses API can use your ChatGPT subscription instead of an API key.

Derived from how [OpenClaw](https://github.com/openclaw/openclaw)'s `openai-codex-responses` transport works via [@mariozechner/pi-ai](https://github.com/mariozechner/pi-ai).

## Requirements

- Node.js >= 18
- [Codex CLI](https://github.com/openai/codex) logged in (`codex` → sign in with ChatGPT)

## Quick start

```bash
git clone https://github.com/spamudji/codex-bridge.git
cd codex-bridge
node bridge.mjs
```

The proxy starts on `http://127.0.0.1:18080`. Configure your tool to point at it.

## Tool configuration

### Factory Droid

In `~/.factory/settings.json`, add to `customModels`:

```json
{
  "model": "gpt-5.4",
  "displayName": "GPT-5.4 (Codex Bridge)",
  "baseUrl": "http://127.0.0.1:18080/v1",
  "apiKey": "codex-bridge",
  "provider": "openai",
  "maxOutputTokens": 16384
}
```

### Cursor / Cline / any OpenAI-compatible tool

- **Base URL:** `http://127.0.0.1:18080/v1`
- **API Key:** `codex-bridge` (any non-empty string — the proxy handles auth)
- **Provider:** OpenAI / OpenAI-compatible

## Auto-start with droid

Instead of starting the proxy manually, wrap your `droid` command.

### PowerShell (Windows)

Add to your `$PROFILE`:

```powershell
function droid {
    $bridge = Start-Process node -ArgumentList "C:\path\to\codex-bridge\bridge.mjs" -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 800
    try {
        & "C:\Users\spamu\bin\droid.exe" @args
    } finally {
        Stop-Process -Id $bridge.Id -Force 2>$null
    }
}
```

### Bash / Zsh (macOS / Linux)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
droid() {
    node ~/codex-bridge/bridge.mjs &
    local pid=$!
    trap "kill $pid 2>/dev/null" RETURN
    sleep 0.8
    command droid "$@"
}
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_PORT` | `18080` | Port the proxy listens on |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Token status + expiry |
| `GET` | `/v1/models` | Available models |
| `POST` | `/v1/responses` | Proxied to Codex backend |

## How it works

1. Reads OAuth tokens from `~/.codex/auth.json` (written by Codex CLI)
2. On each request, checks JWT expiry (with 2-minute buffer)
3. If expired, re-reads `auth.json` (Codex CLI may have refreshed it) — if still expired, refreshes via `auth.openai.com/oauth/token` and writes back
4. Rebuilds request body to match what the Codex backend expects (pi-ai's `buildRequestBody` format)
5. Forwards to `chatgpt.com/backend-api/codex/responses` with required headers (`originator`, `chatgpt-account-id`, `OpenAI-Beta`)
6. Streams SSE response back to the client

## License

MIT
