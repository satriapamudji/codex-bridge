import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Config ---
const PORT = parseInt(process.env.CODEX_BRIDGE_PORT || "18080");
const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const UPSTREAM_HOST = "chatgpt.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_SEC = 120; // refresh 2min before expiry

// --- State ---
const state = {
  accessToken: null,
  refreshToken: null,
  accountId: null,
  exp: 0,
  fileMtime: 0,
};

let refreshLock = null; // prevents concurrent refreshes

// --- Token management ---

function decodeExp(jwt) {
  const seg = jwt.split(".")[1];
  const padded = seg + "=".repeat((4 - (seg.length % 4)) % 4);
  const payload = JSON.parse(
    Buffer.from(padded, "base64").toString("utf8")
  );
  return payload.exp;
}

function loadAuth() {
  let mtime;
  try {
    mtime = statSync(AUTH_PATH).mtimeMs;
  } catch {
    throw new Error(`Cannot stat ${AUTH_PATH} — is Codex CLI logged in?`);
  }
  if (mtime === state.fileMtime && state.accessToken) return;

  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  if (!raw.tokens?.access_token) {
    throw new Error("No access_token in auth.json — run `codex` and log in first");
  }
  state.accessToken = raw.tokens.access_token;
  state.refreshToken = raw.tokens.refresh_token;
  state.accountId = raw.tokens.account_id;
  state.exp = decodeExp(state.accessToken);
  state.fileMtime = mtime;
}

function isExpired() {
  return Math.floor(Date.now() / 1000) >= state.exp - REFRESH_BUFFER_SEC;
}

async function doRefresh() {
  // Re-read file first — Codex CLI may have refreshed already
  state.fileMtime = 0;
  loadAuth();
  if (!isExpired()) {
    log("file had a fresh token, skipping refresh");
    return;
  }

  log("refreshing token...");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  state.accessToken = data.access_token;
  if (data.refresh_token) state.refreshToken = data.refresh_token;
  state.exp = decodeExp(state.accessToken);

  // Write back to auth.json so Codex CLI also sees the new tokens
  const authFile = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  authFile.tokens.access_token = state.accessToken;
  if (data.refresh_token) authFile.tokens.refresh_token = state.refreshToken;
  authFile.last_refresh = new Date().toISOString();
  writeFileSync(AUTH_PATH, JSON.stringify(authFile, null, 2));
  state.fileMtime = statSync(AUTH_PATH).mtimeMs;

  log(`refreshed — expires ${new Date(state.exp * 1000).toISOString()}`);
}

async function ensureToken() {
  loadAuth();
  if (!isExpired()) return;

  // Serialize concurrent refresh attempts
  if (refreshLock) return refreshLock;
  refreshLock = doRefresh().finally(() => {
    refreshLock = null;
  });
  return refreshLock;
}

// --- Helpers ---

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonRes(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// --- Server ---

const server = createServer(async (req, res) => {
  // Health
  if (req.method === "GET" && req.url === "/health") {
    try {
      loadAuth();
    } catch (e) {
      return jsonRes(res, 500, { ok: false, error: e.message });
    }
    return jsonRes(res, 200, {
      ok: true,
      account: state.accountId,
      expires: new Date(state.exp * 1000).toISOString(),
      expired: isExpired(),
    });
  }

  // Minimal /v1/models for tool compatibility
  if (req.method === "GET" && req.url === "/v1/models") {
    return jsonRes(res, 200, {
      object: "list",
      data: [
        { id: "gpt-5.4", object: "model", owned_by: "openai" },
        { id: "gpt-5.3-codex", object: "model", owned_by: "openai" },
        { id: "gpt-5.3-codex-spark", object: "model", owned_by: "openai" },
      ],
    });
  }

  // --- Proxy ---
  try {
    await ensureToken();
  } catch (e) {
    log(`token error: ${e.message}`);
    return jsonRes(res, 502, { error: { message: e.message } });
  }

  let body = await readBody(req);

  // Path rewrite: /v1/responses → /backend-api/codex/responses
  let upstreamPath = req.url;
  if (upstreamPath.startsWith("/v1/")) {
    upstreamPath = "/backend-api/codex/" + upstreamPath.slice(4);
  } else if (upstreamPath === "/v1") {
    upstreamPath = "/backend-api/codex";
  }

  // Patch request body for Codex backend-api compatibility.
  // The Codex backend (chatgpt.com/backend-api/codex/responses) is stricter
  // than the standard OpenAI Responses API (api.openai.com/v1/responses).
  // OpenClaw's openai-codex-responses transport applies similar patches.
  if (body.length > 0 && upstreamPath.endsWith("/responses")) {
    try {
      const src = JSON.parse(body.toString("utf8"));

      // Rebuild body to match pi-ai's buildRequestBody exactly.
      // Only include fields the Codex backend-api accepts.
      const patched = {
        model: src.model,
        store: false,
        stream: true,
        input: src.input,
        text: src.text || { verbosity: "medium" },
        include: ["reasoning.encrypted_content"],
        tool_choice: src.tool_choice ?? "auto",
        parallel_tool_calls: src.parallel_tool_calls ?? true,
      };

      // instructions = system prompt (Codex uses this instead of system message in input)
      if (src.instructions) patched.instructions = src.instructions;

      // Optional fields pi-ai conditionally includes
      if (src.tools) patched.tools = src.tools;
      if (src.temperature !== undefined) patched.temperature = src.temperature;
      if (src.reasoning) patched.reasoning = src.reasoning;

      body = Buffer.from(JSON.stringify(patched), "utf8");
      log(`patched body: model=${patched.model} keys=[${Object.keys(patched)}]`);
    } catch (e) {
      log(`body patch skipped (not JSON): ${e.message}`);
    }
  }

  // Match pi-ai's buildSSEHeaders + buildBaseCodexHeaders exactly.
  // See: @mariozechner/pi-ai/dist/providers/openai-codex-responses.js
  const upstreamHeaders = {
    Authorization: `Bearer ${state.accessToken}`,
    "chatgpt-account-id": state.accountId,
    originator: "pi",
    "OpenAI-Beta": "responses=experimental",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
    "User-Agent": `pi (${process.platform} ${process.arch})`,
  };

  // Always recalculate content-length after body patch
  if (body.length > 0) {
    upstreamHeaders["Content-Length"] = body.length;
  }

  log(`${req.method} ${req.url} → ${UPSTREAM_HOST}${upstreamPath}`);

  const upstream = httpsRequest(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers: upstreamHeaders,
    },
    (upstreamRes) => {
      // Forward headers, skip hop-by-hop
      const skip = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "proxy-authenticate",
        "proxy-authorization",
      ]);
      const fwd = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!skip.has(k.toLowerCase())) fwd[k] = v;
      }

      log(`← ${upstreamRes.statusCode}`);
      res.writeHead(upstreamRes.statusCode, fwd);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (e) => {
    log(`upstream error: ${e.message}`);
    if (!res.headersSent) {
      jsonRes(res, 502, { error: { message: `upstream: ${e.message}` } });
    }
  });

  if (body.length > 0) upstream.write(body);
  upstream.end();
});

// --- Start ---
try {
  loadAuth();
} catch (e) {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
}

server.listen(PORT, "127.0.0.1", () => {
  log("codex-bridge started");
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`account:  ${state.accountId}`);
  log(`expires:  ${new Date(state.exp * 1000).toISOString()}`);
  log("");
  log("Factory / tool config:");
  log(`  baseUrl: http://127.0.0.1:${PORT}/v1`);
  log(`  apiKey:  codex-bridge (any non-empty string)`);
  log(`  provider: openai`);
});
