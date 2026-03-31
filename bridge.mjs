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
const UPSTREAM_ERROR_BODY_MAX_BYTES = 120_000;
const BODY_TIMEOUT_MS = 30_000;
const IDLE_SHUTDOWN_MS = parseInt(process.env.CODEX_BRIDGE_IDLE_MIN || "0") * 60_000;
const DEFAULT_MODEL = "gpt-5.4";
const BRIDGE_OWNER_ID = process.env.CODEX_BRIDGE_OWNER_ID || null;

// --- State ---
const state = {
  accessToken: null,
  refreshToken: null,
  accountId: null,
  exp: 0,
  fileMtime: 0,
};

const BRIDGE_BOOT_ID = `bridge-${Date.now().toString(36)}-${process.pid}`;
const BRIDGE_STARTED_AT = new Date().toISOString();
let requestSeq = 0;
const bridgeStats = {
  bootId: BRIDGE_BOOT_ID,
  totalRequests: 0,
  activeRequests: 0,
  totalBodyReadErrors: 0,
  totalUpstreamErrors: 0,
  upstreamErrorsByStatus: {},
  lastRequestId: null,
  lastModel: null,
  lastClientDisconnects: 0,
  lastErrorAt: null,
  lastError: null,
};

let refreshLock = null;
let idleTimer = null;
let idleCheckInterval = null;

import { execSync } from "node:child_process";

function isDroidRunningSync() {
  try {
    const out = execSync(
      process.platform === "win32"
        ? 'tasklist /FI "IMAGENAME eq droid.exe" /NH'
        : "pgrep -x droid",
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return process.platform === "win32" ? out.includes("droid.exe") : out.trim().length > 0;
  } catch {
    return false;
  }
}

function startIdleWatch() {
  if (IDLE_SHUTDOWN_MS <= 0) return;
  if (idleCheckInterval) return;

  // Check every 60s: if droid is gone AND idle timer hasn't started, start it.
  // If droid comes back, cancel the idle timer.
  idleCheckInterval = setInterval(() => {
    if (isDroidRunningSync()) {
      // Droid is up — cancel any pending idle shutdown
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    } else if (!idleTimer) {
      // Droid is gone — start idle countdown
      log(`droid not running — idle shutdown in ${IDLE_SHUTDOWN_MS / 60_000}min`);
      idleTimer = setTimeout(() => {
        // Double-check droid isn't back
        if (isDroidRunningSync()) {
          idleTimer = null;
          return;
        }
        log("idle shutdown — droid not running");
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000);
      }, IDLE_SHUTDOWN_MS);
      idleTimer.unref();
    }
  }, 60_000);
  idleCheckInterval.unref();
}

function resetIdleTimer() {
  // Any request resets the idle countdown
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// --- Logging (stdout + file) ---

function log(msg) {
  const ts = new Date().toISOString();
  const safeMsg = String(msg).replace(/\u2014/g, "-").replace(/\u2192/g, "->").replace(/\u2190/g, "<-");
  const line = `[${ts.slice(11, 19)}] ${safeMsg}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, `[${ts}] ${safeMsg}\n`);
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

function requestLabel() {
  requestSeq += 1;
  return `${BRIDGE_BOOT_ID}-${String(requestSeq).padStart(4, "0")}`;
}

function startRequest(method, path, model) {
  const requestId = requestLabel();
  let currentModel = model || null;
  bridgeStats.totalRequests += 1;
  bridgeStats.activeRequests += 1;
  bridgeStats.lastRequestId = requestId;
  bridgeStats.lastModel = currentModel;

  const startAt = Date.now();
  let finished = false;

  return {
    id: requestId,
    method,
    path,
    startAt,
    setModel(nextModel) {
      currentModel = nextModel || null;
      bridgeStats.lastModel = currentModel;
    },
    finish: (status, note = "") => {
      if (finished) return;
      finished = true;
      bridgeStats.activeRequests = Math.max(0, bridgeStats.activeRequests - 1);
      const totalMs = Date.now() - startAt;
      log(
        `req:${requestId} done ${method} ${path} model=${currentModel || "n/a"} status=${status} duration=${totalMs}ms${note ? ` ${note}` : ""}`
      );
      if (note) {
        bridgeStats.lastError = note;
      }
    },
  };
}

function recordUpstreamError(status, body) {
  bridgeStats.totalUpstreamErrors += 1;
  bridgeStats.lastErrorAt = new Date().toISOString();
  bridgeStats.upstreamErrorsByStatus[status] = (bridgeStats.upstreamErrorsByStatus[status] || 0) + 1;
  const safeBody = typeof body === "string" ? body.slice(0, 1200) : "";
  bridgeStats.lastError = `${status} ${safeBody}`;
}

function looksLikeByokMismatch(text, modelName, modelRequestPath) {
  if (!text) return false;
  const body = String(text).toLowerCase();
  const model = (modelName || "").toLowerCase();
  const hasModel = model && body.includes(model.toLowerCase());
  const hasHints =
    body.includes("provider") ||
    body.includes("api key") ||
    body.includes("apikey") ||
    body.includes("baseurl") ||
    body.includes("base url") ||
    body.includes("custom model") ||
    body.includes("unsupported model") ||
    body.includes("invalid model") ||
    body.includes("byok");

  if (!hasHints) return false;
  return hasModel || hasHints;
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

function collectStreamBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size <= UPSTREAM_ERROR_BODY_MAX_BYTES) {
        chunks.push(chunk);
      }
    });

    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    stream.on("error", () => {
      resolve("");
    });
  });
}

function collectResponseBody(stream, maxBytes = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        reject(new Error("upstream response body too large"));
        stream.destroy();
        return;
      }
      chunks.push(buf);
    });

    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    stream.on("error", reject);
  });
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
  }

  return {
    raw: block,
    hasData: dataLines.length > 0,
    dataText: dataLines.join("\n"),
  };
}

function isJsonObjectPayload(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed === "[DONE]") return false;

  try {
    const parsed = JSON.parse(trimmed);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function extractLatestEmbeddedResponseObject(text) {
  if (!text) return null;

  let latestResponse = null;
  let searchFrom = 0;

  while (true) {
    const keyIndex = text.indexOf('"response"', searchFrom);
    if (keyIndex === -1) break;

    const colonIndex = text.indexOf(":", keyIndex + 10);
    if (colonIndex === -1) break;

    let objectStart = colonIndex + 1;
    while (objectStart < text.length && /\s/.test(text[objectStart])) objectStart += 1;
    if (text[objectStart] !== "{") {
      searchFrom = colonIndex + 1;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let objectEnd = -1;

    for (let i = objectStart; i < text.length; i += 1) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          objectEnd = i;
          break;
        }
      }
    }

    if (objectEnd === -1) break;

    try {
      const parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.object === "response") {
        latestResponse = parsed;
      }
    } catch {
      // ignore malformed embedded objects
    }

    searchFrom = objectEnd + 1;
  }

  return latestResponse;
}

function decodeJsonStringFragment(fragment) {
  if (typeof fragment !== "string") return null;
  try {
    return JSON.parse(`"${fragment}"`);
  } catch {
    return null;
  }
}

function extractOutputTextFromRawSse(text) {
  if (!text) return "";

  const deltas = [];
  const deltaRegex = /"type":"response\.output_text\.delta"[^]*?"delta":"((?:\\.|[^"\\])*)"/g;
  for (const match of text.matchAll(deltaRegex)) {
    const decoded = decodeJsonStringFragment(match[1]);
    if (decoded) deltas.push(decoded);
  }
  if (deltas.length > 0) return deltas.join("");

  const doneRegex = /"type":"response\.output_text\.done"[^]*?"text":"((?:\\.|[^"\\])*)"/g;
  for (const match of text.matchAll(doneRegex)) {
    const decoded = decodeJsonStringFragment(match[1]);
    if (decoded) return decoded;
  }

  return "";
}

function extractCompletedResponseFromSse(text) {
  if (!text) return null;

  let latestResponse = null;
  let latestCompletedResponse = null;
  let outputText = "";

  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;

    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock.hasData) continue;

    const candidates = [
      parsedBlock.dataText,
      parsedBlock.dataText.replace(/\r?\n/g, ""),
      parsedBlock.dataText.replace(/\r?\n\s*/g, " "),
    ];

    for (const candidate of candidates) {
      if (!isJsonObjectPayload(candidate)) continue;

      try {
        const value = JSON.parse(candidate);
        if (!value || typeof value !== "object") continue;

        if (value.object === "response") {
          latestResponse = value;
          break;
        }

        if (value.response && typeof value.response === "object" && value.response.object === "response") {
          latestResponse = value.response;
          if (value.type === "response.completed") {
            latestCompletedResponse = value.response;
          }
        }

        if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
          outputText += value.delta;
        }

        if (value.type === "response.output_text.done" && typeof value.text === "string" && !outputText) {
          outputText = value.text;
        }

        break;
      } catch {
        // try the next candidate form
      }
    }
  }

  const rawOutputText = extractOutputTextFromRawSse(text);
  const finalOutputText = outputText || rawOutputText;
  const embeddedResponse = latestCompletedResponse || latestResponse || extractLatestEmbeddedResponseObject(text);

  if (embeddedResponse) {
    if (finalOutputText) {
      embeddedResponse.status = embeddedResponse.status === "in_progress" ? "completed" : embeddedResponse.status;
      embeddedResponse.output = [
        {
          id: "msg_bridge_normalized",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: finalOutputText,
              annotations: [],
            },
          ],
        },
      ];
    }

    return embeddedResponse;
  }

  if (!finalOutputText) return null;

  return {
    id: `resp_bridge_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: DEFAULT_MODEL,
    output: [
      {
        id: "msg_bridge_normalized",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: finalOutputText,
            annotations: [],
          },
        ],
      },
    ],
  };
}

function looksLikeSsePayload(text) {
  if (!text) return false;
  const trimmed = text.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

function pipeSanitizedSse(upstreamRes, res, requestId) {
  let buffer = "";

  const flushBlock = (block) => {
    if (!block) return;

    const parsed = parseSseBlock(block);
    if (!parsed.hasData) {
      res.write(`${block}\n\n`);
      return;
    }

    if (!isJsonObjectPayload(parsed.dataText)) {
      const summary = parsed.dataText.trim() || "<empty>";
      log(`req:${requestId} dropping non-object SSE frame: ${summary.slice(0, 200)}`);
      return;
    }

    res.write(`${block}\n\n`);
  };

  const flushAvailable = () => {
    while (true) {
      const lfIndex = buffer.indexOf("\n\n");
      const crlfIndex = buffer.indexOf("\r\n\r\n");

      if (lfIndex === -1 && crlfIndex === -1) return;

      let boundaryIndex = -1;
      let boundaryLength = 0;

      if (lfIndex !== -1 && (crlfIndex === -1 || lfIndex < crlfIndex)) {
        boundaryIndex = lfIndex;
        boundaryLength = 2;
      } else {
        boundaryIndex = crlfIndex;
        boundaryLength = 4;
      }

      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + boundaryLength);
      flushBlock(block);
    }
  };

  upstreamRes.setEncoding("utf8");
  upstreamRes.on("data", (chunk) => {
    buffer += chunk;
    flushAvailable();
  });
  upstreamRes.on("end", () => {
    if (buffer.length > 0) {
      flushBlock(buffer);
    }
    res.end();
  });
  upstreamRes.on("error", (err) => {
    log(`req:${requestId} sanitized SSE stream error: ${err.message}`);
    if (!res.writableEnded) res.end();
  });
}

function jsonRes(res, status, obj) {
  res.__bridgeStatus = status;
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function toTextValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        return JSON.stringify(part);
      })
      .filter((item) => item !== "")
      .join("\n");
  }
  return JSON.stringify(value);
}

function extractSystemPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((m) => m && m.role === "system" && m.content != null)
    .map((m) => toTextValue(m.content))
    .join("\n\n");
}

function normalizeResponsesInput(input) {
  if (Array.isArray(input)) return input;
  if (input == null) return [];

  if (typeof input === "object") {
    if (typeof input.type === "string") {
      return [input];
    }

    if (typeof input.role === "string" && input.content != null) {
      if (Array.isArray(input.content)) {
        return [input];
      }

      const text = toTextValue(input.content);
      if (!text) return [];
      return [
        {
          ...input,
          content: [{ type: "input_text", text }],
        },
      ];
    }
  }

  const text = toTextValue(input);
  if (!text) return [];
  return [
    {
      role: "user",
      content: [{ type: "input_text", text }],
    },
  ];
}

function describeResponsesInputShape(input) {
  if (Array.isArray(input)) return `array(${input.length})`;
  if (input == null) return "null";
  if (typeof input === "string") return "string";
  if (typeof input === "number" || typeof input === "boolean") return typeof input;
  if (typeof input !== "object") return typeof input;

  const parts = ["object"];
  if (typeof input.type === "string") parts.push(`type=${input.type}`);
  if (typeof input.role === "string") parts.push(`role=${input.role}`);
  if (Array.isArray(input.content)) parts.push(`content=array(${input.content.length})`);
  else if (input.content != null) parts.push(`content=${typeof input.content}`);
  return parts.join(" ");
}

function isValidResponsesInputItem(item) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.type === "string") return true;
  return typeof item.role === "string" && Array.isArray(item.content);
}

function messagesToInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const items = [];
  for (const msg of messages) {
    if (!msg || !msg.role || msg.role === "system" || msg.content == null) continue;
    const text = toTextValue(msg.content);
    if (!text) continue;
    items.push({
      role: msg.role,
      content: [{ type: "input_text", text }],
    });
  }
  return items;
}

function buildResponsesPayload(src) {
  const input = src.input != null ? normalizeResponsesInput(src.input) : messagesToInput(src.messages);

  if (!Array.isArray(input)) {
    throw new Error(`responses input normalization failed: got ${describeResponsesInputShape(input)}`);
  }

  const invalidInputIndex = input.findIndex((item) => !isValidResponsesInputItem(item));
  if (invalidInputIndex !== -1) {
    throw new Error(
      `responses input item ${invalidInputIndex} is invalid: ${describeResponsesInputShape(input[invalidInputIndex])}`
    );
  }

  const wantsStream = src.stream === true;

  const patched = {
    model: src.model || DEFAULT_MODEL,
    store: false,
    stream: true,
    input,
    text: src.text || { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: src.tool_choice ?? "auto",
    parallel_tool_calls: src.parallel_tool_calls ?? true,
  };

  patched.instructions =
    src.instructions || extractSystemPrompt(src.messages) || "You are a helpful assistant.";
  if (src.tools) patched.tools = src.tools;
  if (src.temperature !== undefined) patched.temperature = src.temperature;
  if (src.top_p !== undefined) patched.top_p = src.top_p;
  if (src.reasoning) patched.reasoning = src.reasoning;
  if (src.stop !== undefined) patched.stop = src.stop;

  return patched;
}

// --- Server ---

const server = createServer(async (req, res) => {
  resetIdleTimer();
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const isResponses = path === "/v1/responses";
  const isChatCompletions = path === "/v1/chat/completions";
  let requestedModel = null;
  const requestContext = startRequest(req.method || "GET", path, requestedModel);
  let requestDone = false;

  const finalizeRequest = (status = res.__bridgeStatus || 200, note = "") => {
    if (requestDone) return;
    requestDone = true;
    requestContext.finish(status, note);
  };
  const setRequestStatus = (status) => {
    res.__bridgeStatus = status;
  };

  const markFinish = () => finalizeRequest(res.__bridgeStatus);
  const markClose = () => {
    if (!requestDone) {
      bridgeStats.lastClientDisconnects += 1;
      finalizeRequest(0, "client closed");
    }
  };
  res.once("finish", markFinish);
  res.once("close", markClose);

  if (req.method === "GET" && path === "/health") {
    try {
      loadAuth();
    } catch (e) {
      return jsonRes(res, 500, { ok: false, error: e.message });
    }
    setRequestStatus(200);
    return jsonRes(res, 200, {
      ok: true,
      ownerId: BRIDGE_OWNER_ID,
      account: state.accountId,
      expires: new Date(state.exp * 1000).toISOString(),
      expired: isExpired(),
      lastModel: bridgeStats.lastModel,
      bridgePid: process.pid,
      bootId: BRIDGE_BOOT_ID,
      startedAt: BRIDGE_STARTED_AT,
      uptimeSec: Math.floor((Date.now() - Date.parse(BRIDGE_STARTED_AT)) / 1000),
      totalRequests: bridgeStats.totalRequests,
      activeRequests: bridgeStats.activeRequests,
      totalUpstreamErrors: bridgeStats.totalUpstreamErrors,
      upstreamErrorsByStatus: bridgeStats.upstreamErrorsByStatus,
      lastError: bridgeStats.lastError,
      lastErrorAt: bridgeStats.lastErrorAt,
      lastClientDisconnects: bridgeStats.lastClientDisconnects,
    });
  }

  if (req.method === "GET" && path === "/_bridge_status") {
    setRequestStatus(200);
    return jsonRes(res, 200, {
      ok: true,
      pid: process.pid,
      ownerId: BRIDGE_OWNER_ID,
      bootId: BRIDGE_BOOT_ID,
      lastModel: bridgeStats.lastModel,
      startedAt: BRIDGE_STARTED_AT,
      uptimeSec: Math.floor((Date.now() - Date.parse(BRIDGE_STARTED_AT)) / 1000),
      totalRequests: bridgeStats.totalRequests,
      activeRequests: bridgeStats.activeRequests,
      upstreamErrorsByStatus: bridgeStats.upstreamErrorsByStatus,
      totalUpstreamErrors: bridgeStats.totalUpstreamErrors,
      lastError: bridgeStats.lastError,
      lastErrorAt: bridgeStats.lastErrorAt,
      lastClientDisconnects: bridgeStats.lastClientDisconnects,
    });
  }

  if (req.method === "GET" && path === "/v1/models") {
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
    setRequestStatus(502);
    return jsonRes(res, 502, { error: { message: e.message } });
  }

  let body;
  let parsedBody = null;
  try {
    body = await readBody(req);
  } catch (e) {
    log(`body read error: ${e.message}`);
    bridgeStats.totalBodyReadErrors += 1;
    setRequestStatus(400);
    return jsonRes(res, 400, { error: { message: e.message } });
  }

  let upstreamPath = path;
  if (upstreamPath.startsWith("/v1/")) {
    upstreamPath = "/backend-api/codex/" + upstreamPath.slice(4);
  } else if (upstreamPath === "/v1") {
    upstreamPath = "/backend-api/codex";
  }

  if (body.length > 0 && (isResponses || isChatCompletions)) {
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
      requestedModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;
      requestContext.setModel(requestedModel);

      if (isChatCompletions) upstreamPath = "/backend-api/codex/responses";
      const patched = buildResponsesPayload(parsedBody);
      requestedModel = patched.model;
      requestContext.setModel(requestedModel);
      body = Buffer.from(JSON.stringify(patched), "utf8");
      log(`${isChatCompletions ? "patched chat completion" : "patched responses"}: model=${patched.model}`);
    } catch (e) {
      setRequestStatus(400);
      log(`body patch failed: ${e.message}`);
      return jsonRes(res, 400, {
        error: { message: `invalid JSON body: ${e.message}` },
      });
    }
  }

  const wantsStream = parsedBody?.stream === true;

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

  log(`req:${requestContext.id} -> ${req.method} ${upstreamPath} model=${requestedModel || "n/a"}`);
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
        "content-length",
        "transfer-encoding",
        "proxy-authenticate",
        "proxy-authorization",
      ]);
      const fwd = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!skip.has(k.toLowerCase())) fwd[k] = v;
      }

      const statusCode = upstreamRes.statusCode || 500;
      const upstreamCt = (upstreamRes.headers["content-type"] || "").toLowerCase();

      log(`← ${statusCode}`);
      setRequestStatus(statusCode);
      log(`req:${requestContext.id} <- ${statusCode}`);
      if (statusCode >= 400) {
        collectStreamBody(upstreamRes)
          .then((rawBody) => {
            const normalizedBody = rawBody || "";
            const safeBody =
              normalizedBody.length > 2000 ? `${normalizedBody.slice(0, 2000)}...` : normalizedBody;
            recordUpstreamError(statusCode, safeBody);
            log(`upstream error body: ${safeBody || "<empty>"}`);

            if (statusCode === 400 && looksLikeByokMismatch(safeBody, requestedModel, requestedModel || "")) {
              log(
                `req:${requestContext.id} BYOK/proxy mismatch hint: check ~/.factory/settings.json entry model=codex bridge, provider=openai, baseUrl=http://127.0.0.1:${PORT}/v1`
              );
            }

            if (res.headersSent || res.writableEnded || res.destroyed) {
              return;
            }

            if (upstreamCt.includes("application/json")) {
              try {
                const parsed = JSON.parse(normalizedBody || "{}");
                res.writeHead(statusCode, { "Content-Type": "application/json" });
                res.end(JSON.stringify(parsed));
                return;
              } catch {
                // keep fallback below
              }
            }

            res.writeHead(statusCode, { "Content-Type": upstreamCt || "application/json" });
            if (normalizedBody) {
              res.end(normalizedBody);
            } else {
              res.end(JSON.stringify({ error: { message: `upstream returned ${statusCode} with empty body` } }));
            }
          })
          .catch(() => {
              if (!res.writableEnded && !res.headersSent) {
                log("failed to read upstream error body");
                recordUpstreamError(statusCode, "failed to read upstream error body");
                res.writeHead(statusCode, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: `upstream returned ${statusCode}` } }));
              }
            });
        return;
      }

      if (!wantsStream) {
        log(`req:${requestContext.id} normalizing non-stream success content-type=${upstreamCt || "<empty>"}`);
        collectResponseBody(upstreamRes)
          .then((rawBody) => {
            let responsePayload = null;

            if (upstreamCt.includes("text/event-stream") || looksLikeSsePayload(rawBody)) {
              responsePayload = extractCompletedResponseFromSse(rawBody);
            } else if (upstreamCt.includes("application/json")) {
              try {
                responsePayload = JSON.parse(rawBody || "{}");
              } catch {
                responsePayload = null;
              }
            }

            if (!responsePayload || typeof responsePayload !== "object" || Array.isArray(responsePayload)) {
              const summary = (rawBody || "").slice(0, 1000);
              log(`req:${requestContext.id} could not normalize non-stream response: ${summary || "<empty>"}`);
              if (!res.headersSent && !res.writableEnded) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "bridge could not normalize non-stream responses payload" } }));
              }
              return;
            }

            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(statusCode, { "Content-Type": "application/json" });
              res.end(JSON.stringify(responsePayload));
            }
          })
          .catch((err) => {
            log(`req:${requestContext.id} non-stream response normalization failed: ${err.message}`);
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: `bridge normalization failed: ${err.message}` } }));
            }
          });
        return;
      }

      res.writeHead(statusCode, fwd);
      if (wantsStream && (isResponses || isChatCompletions) && upstreamCt.includes("text/event-stream")) {
        pipeSanitizedSse(upstreamRes, res, requestContext.id);
        return;
      }
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
  log(`idle shutdown: ${IDLE_SHUTDOWN_MS > 0 ? IDLE_SHUTDOWN_MS / 60_000 + "min after droid exits" : "disabled"}`);
  log(`log file: ${LOG_PATH}`);
  startIdleWatch();
});
