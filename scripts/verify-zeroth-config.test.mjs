import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("verify config ignores placeholder client IDs for disabled providers", () => {
  const tempRoot = tempDeploymentRoot({
    SPOTIFY_CLIENT_ID: "replace-with-spotify-oauth-client-id",
    DISABLED_PROVIDERS: "spotify",
  });

  const result = runVerifier(tempRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("verify config rejects placeholder client IDs for active providers", () => {
  const tempRoot = tempDeploymentRoot({
    SPOTIFY_CLIENT_ID: "replace-with-spotify-oauth-client-id",
    DISABLED_PROVIDERS: "",
  });

  const result = runVerifier(tempRoot);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /spotify_client_id/);
});

function tempDeploymentRoot(vars) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wavey-id-verify-"));
  fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts/verify-zeroth-config.mjs"),
    path.join(tempRoot, "scripts/verify-zeroth-config.mjs"),
  );
  fs.copyFileSync(path.join(root, "zeroth.clients.sql"), path.join(tempRoot, "zeroth.clients.sql"));
  const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.zeroth.jsonc"), "utf8"));
  config.vars = {
    ...config.vars,
    ...vars,
  };
  fs.writeFileSync(path.join(tempRoot, "wrangler.zeroth.jsonc"), JSON.stringify(config, null, 2));
  return tempRoot;
}

function runVerifier(tempRoot) {
  return spawnSync("node", ["scripts/verify-zeroth-config.mjs"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: process.env.CI || "1",
    },
  });
}
