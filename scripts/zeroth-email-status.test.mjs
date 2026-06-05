import assert from "node:assert/strict";
import test from "node:test";

import { emailStatusSummary } from "./zeroth-email-status.mjs";

const config = {
  vars: {
    PRODUCT_NAME: "Wavey ID",
    MAGIC_LINK_FROM: "login@wavey.ai",
  },
  send_email: [
    {
      name: "EMAIL",
      allowed_sender_addresses: ["login@wavey.ai"],
    },
  ],
};

test("email status reports live magic link delivery blockers", async () => {
  const summary = await emailStatusSummary({
    live: true,
    config,
    envFileValues: { ADMIN_TOKEN: "admin-token" },
    fetchFn: async (url, options) => {
      assert.equal(url, "https://id.wavey.ai/local-auth/status");
      assert.equal(options.headers.Authorization, "Bearer admin-token");
      return jsonResponse(200, {
        methods: [
          {
            id: "magic_link",
            enabled: true,
            delivery: "cloudflare_email",
            notes: ["delivery_not_proven", "delivery_failed_recently"],
            deliveryStatus: {
              lastIssueAt: 1780630448,
              lastFailedAt: 1780630448,
              lastError: "email_internal_server_error",
              lastErrorDetail: "email.sending.error.internal_server [code: 10002]",
            },
          },
        ],
      });
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.config.sender, "login@wavey.ai");
  assert.equal(summary.config.sender_allowed, true);
  assert.deepEqual(summary.blockers, [
    "magic link email delivery failed recently: email_internal_server_error (email.sending.error.internal_server [code: 10002])",
    "magic link email delivery is not proven",
  ]);
  assert.match(summary.next_actions.join("\n"), /request a fresh magic link/);
});

test("email status captures Cloudflare Email Sending API failures", async () => {
  const commands = [];
  const summary = await emailStatusSummary({
    remote: true,
    sendTest: true,
    config,
    runCommand: (command, args) => {
      commands.push([command, ...args].join(" "));
      if (args.includes("list") || args.includes("dns")) {
        return failed("Unauthorized [code: 2036]");
      }
      return failed("email.sending.error.internal_server [code: 10002]");
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.cloudflare_email.zones.error, "Unauthorized [code: 2036]");
  assert.equal(summary.cloudflare_email.dns.error, "Unauthorized [code: 2036]");
  assert.equal(
    summary.cloudflare_email.send.error,
    "email.sending.error.internal_server [code: 10002]",
  );
  assert.match(summary.blockers.join("\n"), /zone listing failed/);
  assert.match(summary.blockers.join("\n"), /test send failed/);
  assert(commands.some((command) => command.includes("email sending send")));
});

test("email status is ready when config and live delivery are clean", async () => {
  const summary = await emailStatusSummary({
    requireReady: true,
    live: true,
    config,
    envFileValues: { ADMIN_TOKEN: "admin-token" },
    fetchFn: async () =>
      jsonResponse(200, {
        methods: [
          {
            id: "magic_link",
            enabled: true,
            delivery: "cloudflare_email",
            notes: [],
            deliveryStatus: {
              lastIssueAt: 1780630448,
              lastSentAt: 1780630448,
            },
          },
        ],
      }),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.blockers, []);
});

test("email status catches sender not allowed by restricted binding", async () => {
  const summary = await emailStatusSummary({
    config: {
      vars: { MAGIC_LINK_FROM: "login@wavey.ai" },
      send_email: [
        {
          name: "EMAIL",
          allowed_sender_addresses: ["noreply@wavey.ai"],
        },
      ],
    },
  });

  assert.equal(summary.ready, false);
  assert.deepEqual(summary.blockers, [
    "MAGIC_LINK_FROM is not allowed by send_email binding",
  ]);
});

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function failed(stderr) {
  return {
    status: 1,
    stdout: "",
    stderr,
  };
}
