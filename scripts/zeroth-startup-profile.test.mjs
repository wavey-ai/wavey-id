import assert from "node:assert/strict";
import test from "node:test";

import {
  startupProfileMetrics,
  startupProfileSummary,
} from "./zeroth-startup-profile.mjs";

test("startup profile metrics exclude idle samples from active CPU", () => {
  const profile = {
    nodes: [
      node(1, "(root)"),
      node(2, "(idle)"),
      node(3, "fetch"),
      node(4, "Response"),
    ],
    samples: [2, 3, 4],
    timeDeltas: [3000, 1500, 2000],
    startTime: 10_000,
    endTime: 20_000,
  };

  assert.deepEqual(startupProfileMetrics(profile), {
    active_sampled_cpu_ms: 3.5,
    sampled_profile_ms: 6.5,
    wall_ms: 10,
    sample_count: 3,
    node_count: 4,
  });
});

test("startup profile summary enforces the active CPU budget", () => {
  const profile = {
    nodes: [node(1, "(idle)"), node(2, "fetch")],
    samples: [1, 2],
    timeDeltas: [9000, 2500],
    startTime: 0,
    endTime: 20_000,
  };

  assert.equal(startupProfileSummary(profile, { maxCpuMs: 3 }).ok, true);
  const failed = startupProfileSummary(profile, { maxCpuMs: 2 });
  assert.equal(failed.ok, false);
  assert.equal(failed.measured_ms, 2.5);
  assert.equal(failed.measured_kind, "active_sampled_cpu_ms");
});

test("startup profile summary falls back to wall time when samples are missing", () => {
  const summary = startupProfileSummary({
    nodes: [],
    samples: [],
    timeDeltas: [],
    startTime: 100,
    endTime: 10_100,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.measured_ms, 10);
  assert.equal(summary.measured_kind, "wall_ms");
  assert.equal(summary.active_sampled_cpu_ms, null);
});

test("startup profile summary rejects unusable timing data", () => {
  const summary = startupProfileSummary({ nodes: [], samples: [], timeDeltas: [] });

  assert.equal(summary.ok, false);
  assert.match(summary.error, /usable timing data/);
});

function node(id, functionName) {
  return {
    id,
    callFrame: {
      functionName,
      scriptId: "0",
      url: "",
      lineNumber: -1,
      columnNumber: -1,
    },
  };
}
