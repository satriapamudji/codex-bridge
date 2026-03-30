import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, statSync, renameSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Config ---
const PORT = parseInt(process.env.CODEX_BRIDGE_PORT || "18080");
const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const LOG_PATH = join(homedir(), ".codex", "bridge.log");
const UPSTREAM_HOST = "chatgpt.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_BUFFER_SEC = 120;
const UPSTREAM_TIMEOUT_MS = 120_000;
const BODY_MAX_BYTES = 10 * 1024 * 1024;
const BODY_TIMEOUT_MS = 30_000;

// --- State ---
const state = {
  accessToken: null,
  refreshToken: null,
  accountId: null,
  exp: 0,
  fileMtime: 0,
};

let refreshLock = null;

// --- Logging (stdout + file) ---

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts.slice(11, 19)}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
  } catch {}
}

// --- Global error handlers (prevent silent crashes under nohup) ---

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : reason}`);
});

// --- Token management ---

function decodeExp(jwt) {
  try {
    const seg = jwt.split(".")[1];
    const padded = seg + "=".repeat((4 - (seg.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")).exp;
  } catch {
    throw new Error("Failed to decode JWT — token may be corrupt");
  }
}

function loadAuth() {
  let mtime;
  try {
    mtime = statSync(AUTH_PATH).mtimeMs;
  } catch {
    throw new Error(`Cannot stat ${AUTH_PATH} — is Codex CLI logged in?`);
  }
  if (mtime === state.fileMtime && state.accessToken) return;

  let raw;
  try {
    raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse auth.json (may be mid-write): ${e.message}`);
  }

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

function atomicWriteJson(filepath, data) {
  const tmp = filepath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filepath);
}

async function doRefresh() {
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

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`token refresh network error: ${e.message}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  state.accessToken = data.access_token;
  if (data.refresh_token) state.refreshToken = data.refresh_token;
  state.exp = decodeExp(state.accessToken);

  try {
    const authFile = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    authFile.tokens.access_token = state.accessToken;
    if (data.refresh_token) authFile.tokens.refresh_token = state.refreshToken;
    authFile.last_refresh = new Date().toISOString();
    atomicWriteJson(AUTH_PATH, authFile);
    state.fileMtime = statSync(AUTH_PATH).mtimeMs;
  } catch (e) {
    log(`warning: could not write back auth.json: ${e.message}`);
  }

  log(`refreshed — expires ${new Date(state.exp * 1000).toISOString()}`);
}

async function ensureToken() {
  loadAuth();
  if (!isExpired()) return;

  if (refreshLock) return refreshLock;
  refreshLock = doRefresh().finally(() => {
    refreshLock = null;
  });
  return refreshLock;
}

// --- Helpers ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("request body read timed out"));
    }, BODY_TIMEOUT_MS);

    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX_BYTES) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function jsonRes(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// --- Server ---

const server = createServer(async (req, res) => {
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

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    log(`body read error: ${e.message}`);
    return jsonRes(res, 400, { error: { message: e.message } });
  }

  let upstreamPath = req.url;
  if (upstreamPath.startsWith("/v1/")) {
    upstreamPath = "/backend-api/codex/" + upstreamPath.slice(4);
  } else if (upstreamPath === "/v1") {
    upstreamPath = "/backend-api/codex";
  }

  if (body.length > 0 && upstreamPath.endsWith("/responses")) {
    try {
      const src = JSON.parse(body.toString("utf8"));

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

      if (src.instructions) patched.instructions = src.instructions;
      if (src.tools) patched.tools = src.tools;
      if (src.temperature !== undefined) patched.temperature = src.temperature;
      if (src.reasoning) patched.reasoning = src.reasoning;

      body = Buffer.from(JSON.stringify(patched), "utf8");
      log(`patched: model=${patched.model} keys=[${Object.keys(patched)}]`);
    } catch (e) {
      log(`body patch skipped: ${e.message}`);
    }
  }

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

  if (body.length > 0) {
    upstreamHeaders["Content-Length"] = body.length;
  }

  log(`→ ${req.method} ${upstreamPath}`);

  const upstream = httpsRequest(
    {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers: upstreamHeaders,
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (upstreamRes) => {
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

  upstream.on("timeout", () => {
    log("upstream timeout — aborting");
    upstream.destroy(new Error("upstream timeout"));
  });

  upstream.on("error", (e) => {
    log(`upstream error: ${e.message}`);
    jsonRes(res, 502, { error: { message: `upstream: ${e.message}` } });
  });

  // Abort upstream if client disconnects early
  res.on("close", () => {
    if (!upstream.destroyed) upstream.destroy();
  });

  if (body.length > 0) upstream.write(body);
  upstream.end();
});

// --- EADDRINUSE ---
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[fatal] port ${PORT} already in use — is another bridge running?`);
    process.exit(1);
  }
  log(`server error: ${e.message}`);
});

// --- Graceful shutdown ---
function shutdown(signal) {
  log(`${signal} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

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
  log(`log file: ${LOG_PATH}`);
});
