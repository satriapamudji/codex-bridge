# codex-bridge

Local proxy that routes OpenAI Responses API requests through your Codex/ChatGPT subscription. Zero dependencies - just Node.js.

## Requirements

- Node.js >= 18
- [Codex CLI](https://github.com/openai/codex) logged in (`codex` -> sign in with ChatGPT)

## Quick start

```bash
git clone https://github.com/spamudji/codex-bridge.git
cd codex-bridge
node bridge.mjs
```

The proxy listens on `http://127.0.0.1:18080` by default.

## Factory Droid settings

Run the one-time migration once to patch your live `~/.factory/settings.json` automatically:

```bash
npm run migrate:factory
```

This command only adds entries for models hosted by this bridge and leaves everything else untouched. It also keeps a timestamped backup file at `~/.factory/settings.json.bak-*` before making changes.

If you prefer manual edits, this is the equivalent block to include in `customModels` (or equivalent section):

```json
[
  {
    "model": "gpt-5.4",
    "displayName": "GPT-5.4 (Codex Bridge)",
    "baseUrl": "http://127.0.0.1:18080/v1",
    "apiKey": "codex-bridge",
    "provider": "openai",
    "maxOutputTokens": 16384
  },
  {
    "model": "gpt-5.3-codex",
    "displayName": "GPT-5.3 Codex (Codex Bridge)",
    "baseUrl": "http://127.0.0.1:18080/v1",
    "apiKey": "codex-bridge",
    "provider": "openai",
    "maxOutputTokens": 8192
  },
  {
    "model": "gpt-5.3-codex-spark",
    "displayName": "GPT-5.3 Codex Spark (Codex Bridge)",
    "baseUrl": "http://127.0.0.1:18080/v1",
    "apiKey": "codex-bridge",
    "provider": "openai",
    "maxOutputTokens": 8192
  }
]
```

To inspect your settings after migration, use:

```bash
jq '.customModels[] | select(.model | test("gpt-5\\.4|gpt-5\\.3-codex|gpt-5\\.3-codex-spark"))' ~/.factory/settings.json
```

## Auto-start with droid (recommended)

### `droid.ps1` (PowerShell)

Use the wrapper script in `droid.ps1` and call it from your profile:

```powershell
function droid {
  & "C:\path\to\codex-bridge\droid.ps1" @args
}
```

If you need to force a specific binary, set:

```powershell
$env:CODEX_DROID_CMD = "C:\Path\To\droid.exe"
```

### `droid.sh` (Bash / Zsh)

```bash
droid() {
  /path/to/codex-bridge/droid.sh "$@"
}
```

Both wrappers now:

- reuse an already-running bridge by checking `/_bridge_status` (startup probe only)
- start a new bridge only if `/_bridge_status` is unreachable
- only stop the bridge they started
- preserve bridge ownership across droids via a per-launch `CODEX_BRIDGE_OWNER_ID` value so one droid can’t kill a bridge owned by another launcher

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_PORT` | `18080` | Proxy listen port |
| `CODEX_DROID_CMD` | (auto-detected) | Optional explicit `droid` command used by `droid.ps1` |
| `CODEX_BRIDGE_IDLE_MIN` | `0` | Auto-stop delay in minutes after droid exits; set to `0` to disable |

`droid.ps1`, `droid.sh`, and `ensure.cmd` force `CODEX_BRIDGE_IDLE_MIN=0` when they start bridge.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Token status + expiry |
| `GET` | `/_bridge_status` | Lightweight process health, owner token, request counters, and last error details |
| `GET` | `/v1/models` | Available models |
| `POST` | `/v1/responses` | Proxied request to Codex backend |

## Logging

Bridge logs are written to `~/.codex/bridge.log`.

- Linux/macOS: `tail -f ~/.codex/bridge.log`
- `systemd` services: `journalctl -u <service> -f` for process lifecycle + `~/.codex/bridge.log` for request logs.

Useful startup/log checks:

```bash
curl -s http://127.0.0.1:18080/_bridge_status | jq
tail -f ~/.codex/bridge.log
```

If you see BYOK 400s for `gpt-5` models, check that `~/.factory/settings.json` has:

```text
provider: openai
baseUrl: http://127.0.0.1:18080/v1
apiKey: codex-bridge
```

## How it works

1. Reads OAuth tokens from `~/.codex/auth.json` (written by Codex CLI)
2. Checks JWT expiry before forwarding
3. Refreshes token if needed and writes back to `auth.json`
4. Converts request payload to Codex responses format
5. Proxies to `chatgpt.com/backend-api/codex/responses`
6. Streams SSE response back to the caller

## License

MIT
