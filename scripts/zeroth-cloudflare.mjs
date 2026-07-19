#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.error(
    [
      "usage: node scripts/zeroth-cloudflare.mjs <command> [args...]",
      "",
      "Runs a command with the Cloudflare credential path used by the Wavey account.",
      "If CLOUDFLARE_API_KEY is already set, it is reused.",
      "If not, CLOUDFLARE_API_KEY_PATH or ../.cloudflare-token is read as a global API key.",
      "CLOUDFLARE_EMAIL defaults to jamie@wavey.ai.",
      "Set ZEROTH_CLOUDFLARE_AUTH=oauth to skip global-key injection.",
    ].join("\n"),
  );
  process.exit(args.length === 0 ? 1 : 0);
}

const env = cloudflareEnv(process.env);
const result = spawnSync(args[0], args.slice(1), {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

function cloudflareEnv(sourceEnv) {
  const env = { ...sourceEnv };
  if (env.ZEROTH_CLOUDFLARE_AUTH === "oauth") {
    return env;
  }

  const tokenPath = env.CLOUDFLARE_API_KEY_PATH || path.resolve(root, "..", ".cloudflare-token");
  let apiKey = env.CLOUDFLARE_API_KEY || "";
  if (!apiKey && isReadableFile(tokenPath)) {
    apiKey = fs.readFileSync(tokenPath, "utf8").replace(/[\r\n]/g, "").trim();
  }

  if (!apiKey) {
    return env;
  }

  env.CLOUDFLARE_API_KEY = apiKey;
  env.CLOUDFLARE_EMAIL = env.CLOUDFLARE_EMAIL || "jamie@wavey.ai";
  delete env.CLOUDFLARE_API_TOKEN;

  if (env.ZEROTH_CLOUDFLARE_VERBOSE === "1") {
    const displayPath = path.relative(root, tokenPath) || tokenPath;
    console.error(`using Cloudflare global API key from ${displayPath} for ${env.CLOUDFLARE_EMAIL}`);
  }

  return env;
}

function isReadableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
