#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BRIDGE_MODELS = [
  {
    model: "gpt-5.4",
    displayName: "GPT-5.4 (Codex Bridge)",
    baseUrl: "http://127.0.0.1:18080/v1",
    apiKey: "codex-bridge",
    provider: "openai",
    maxOutputTokens: 16384,
  },
  {
    model: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex (Codex Bridge)",
    baseUrl: "http://127.0.0.1:18080/v1",
    apiKey: "codex-bridge",
    provider: "openai",
    maxOutputTokens: 8192,
  },
  {
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark (Codex Bridge)",
    baseUrl: "http://127.0.0.1:18080/v1",
    apiKey: "codex-bridge",
    provider: "openai",
    maxOutputTokens: 8192,
  },
];

const DEFAULT_PORT = process.env.CODEX_BRIDGE_PORT || "18080";
const BRIDGE_HOST = process.env.CODEX_BRIDGE_HOST || "127.0.0.1";
const BRIDGE_SETTINGS_PATH = path.join(os.homedir(), ".factory", "settings.json");

function resolveBaseUrl() {
  return `http://${BRIDGE_HOST}:${DEFAULT_PORT}/v1`;
}

function parseJson(text) {
  return JSON.parse(text);
}

function loadSettings(parsed, settingsPath) {
  const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);

  if (isObject) {
    if (Array.isArray(parsed.customModels)) {
      return { root: parsed, modelsRef: parsed.customModels, pointer: "customModels" };
    }
    if (Array.isArray(parsed.models)) {
      return { root: parsed, modelsRef: parsed.models, pointer: "models" };
    }
    parsed.customModels = [];
    return { root: parsed, modelsRef: parsed.customModels, pointer: "customModels" };
  }

  if (Array.isArray(parsed)) {
    return { root: parsed, modelsRef: parsed, pointer: "root" };
  }

  throw new Error(`Unsupported settings format in ${settingsPath}`);
}

function ensureBridgeModels(modelsRef) {
  const existing = new Set(
    modelsRef
      .filter((entry) => entry && typeof entry.model === "string" && entry.model.trim().length > 0)
      .map((entry) => entry.model),
  );
  const toAdd = [];
  const baseUrl = resolveBaseUrl();

  for (const model of BRIDGE_MODELS) {
    if (existing.has(model.model)) {
      continue;
    }

    toAdd.push({ ...model, baseUrl });
  }

  if (toAdd.length === 0) {
    return 0;
  }

  modelsRef.push(...toAdd);
  return toAdd.length;
}

function createBackup(settingsPath, content) {
  const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${settingsPath}.bak-${backupStamp}`;
  return fs.writeFile(backupPath, content, "utf8").then(() => backupPath);
}

async function migrate() {
  const settingsDir = path.dirname(BRIDGE_SETTINGS_PATH);
  await fs.mkdir(settingsDir, { recursive: true });
  let existingContent = "";
  let fileExisted = false;

  try {
    existingContent = await fs.readFile(BRIDGE_SETTINGS_PATH, "utf8");
    fileExisted = true;
    if (!existingContent.trim()) {
      existingContent = "{}";
    }
  } catch {
    existingContent = "{}";
  }

  let parsed;
  try {
    parsed = parseJson(existingContent);
  } catch (err) {
    throw new Error(`Cannot parse ${BRIDGE_SETTINGS_PATH}: ${err.message}`);
  }

  const { root, modelsRef, pointer } = loadSettings(parsed, BRIDGE_SETTINGS_PATH);
  const added = ensureBridgeModels(modelsRef);

  if (added === 0) {
    console.log("No migration needed. Bridge models already present.");
    return;
  }

  if (fileExisted) {
    const backupPath = await createBackup(BRIDGE_SETTINGS_PATH, existingContent);
    console.log(`Backup created: ${backupPath}`);
  }
  const nextContent = JSON.stringify(root, null, 2) + "\n";
  await fs.writeFile(BRIDGE_SETTINGS_PATH, nextContent, "utf8");
  console.log(`Migrated ${BRIDGE_SETTINGS_PATH}: added ${added} model(s) to ${pointer}.`);
}

try {
  await migrate();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
