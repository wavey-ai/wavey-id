#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

if (isCli()) {
  runCli(process.argv.slice(2));
}

function runCli(args) {
  const options = parseArgs(args, process.env);
  if (!Number.isFinite(options.maxCpuMs) || options.maxCpuMs <= 0) {
    printFailureAndExit("max CPU budget must be a positive number");
  }

  const resolvedProfilePath = path.resolve(root, options.profilePath);
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(resolvedProfilePath, "utf8"));
  } catch (error) {
    printFailureAndExit(`could not read startup CPU profile: ${error.message}`);
  }

  const summary = startupProfileSummary(profile, {
    maxCpuMs: options.maxCpuMs,
    profilePath: resolvedProfilePath,
    rootDir: root,
  });
  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    process.exit(1);
  }
}

function parseArgs(args, env) {
  let profilePath = "worker-startup.cpuprofile";
  let maxCpuMs = Number(env.ZEROTH_STARTUP_CPU_MAX_MS || "10");
  for (const arg of args) {
    if (arg.startsWith("--max-cpu-ms=")) {
      maxCpuMs = Number(arg.slice("--max-cpu-ms=".length));
    } else if (!arg.startsWith("--")) {
      profilePath = arg;
    }
  }
  return { maxCpuMs, profilePath };
}

export function startupProfileSummary(profile, {
  maxCpuMs = 10,
  profilePath = "worker-startup.cpuprofile",
  rootDir = process.cwd(),
} = {}) {
  if (!Number.isFinite(maxCpuMs) || maxCpuMs <= 0) {
    return { ok: false, error: "max CPU budget must be a positive number" };
  }

  const metrics = startupProfileMetrics(profile);
  const measuredMs = metrics.active_sampled_cpu_ms ?? metrics.sampled_profile_ms ?? metrics.wall_ms;
  const measuredKind = metrics.active_sampled_cpu_ms === null
    ? metrics.sampled_profile_ms === null
      ? "wall_ms"
      : "sampled_profile_ms"
    : "active_sampled_cpu_ms";

  if (measuredMs === null) {
    return {
      ok: false,
      error: "startup CPU profile did not include usable timing data",
      ...metrics,
    };
  }

  return {
    ok: measuredMs <= maxCpuMs,
    profile_path: path.relative(rootDir, profilePath),
    max_cpu_ms: maxCpuMs,
    measured_ms: measuredMs,
    measured_kind: measuredKind,
    ...metrics,
  };
}

export function startupProfileMetrics(profile) {
  const timeDeltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const nodesById = new Map(
    (Array.isArray(profile?.nodes) ? profile.nodes : []).map((node) => [node.id, node]),
  );
  let sampledProfileMicroseconds = 0;
  let activeSampledCpuMicroseconds = 0;
  let usableDeltas = 0;
  for (let index = 0; index < timeDeltas.length; index += 1) {
    const delta = timeDeltas[index];
    if (!Number.isFinite(delta) || delta < 0) {
      continue;
    }
    usableDeltas += 1;
    sampledProfileMicroseconds += delta;
    const node = nodesById.get(samples[index]);
    if (node?.callFrame?.functionName !== "(idle)") {
      activeSampledCpuMicroseconds += delta;
    }
  }
  const sampledProfileMs = usableDeltas > 0
    ? roundMs(sampledProfileMicroseconds / 1000)
    : null;
  const activeSampledCpuMs = usableDeltas > 0
    ? roundMs(activeSampledCpuMicroseconds / 1000)
    : null;
  const wallMs = Number.isFinite(profile?.startTime) && Number.isFinite(profile?.endTime)
    ? roundMs((profile.endTime - profile.startTime) / 1000)
    : null;
  return {
    active_sampled_cpu_ms: activeSampledCpuMs,
    sampled_profile_ms: sampledProfileMs,
    wall_ms: wallMs,
    sample_count: Array.isArray(profile?.samples) ? profile.samples.length : 0,
    node_count: Array.isArray(profile?.nodes) ? profile.nodes.length : 0,
  };
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function printFailureAndExit(message, details = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exit(1);
}

function isCli() {
  return process.argv[1]
    && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
}
