import assert from "node:assert/strict";
import test from "node:test";

import { emailStatusSummary } from "./zeroth-email-status.mjs";

const config = {
  account_id: "account-123",
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
    env: {
      CLOUDFLARE_API_KEY: "global-key",
      CLOUDFLARE_EMAIL: "jamie@wavey.ai",
    },
    fetchFn: async (url, options) => {
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/account-123/subscriptions",
      );
      assert.equal(options.headers["X-Auth-Email"], "jamie@wavey.ai");
      assert.equal(options.headers["X-Auth-Key"], "global-key");
      return jsonResponse(200, {
        success: true,
        result: [
          {
            state: "Paid",
            rate_plan: {
              id: "free",
              public_name: "Cloudflare Free Plan",
              scope: "zone",
            },
          },
          {
            state: "Paid",
            rate_plan: {
              id: "r2_paid",
              public_name: "R2 Paid",
              scope: "account",
            },
          },
        ],
      });
    },
    runCommand: (command, args) => {
      commands.push([command, ...args].join(" "));
      if (args.includes("list") || args.includes("dns")) {
        return failed("Unauthorized [code: 2036]");
      }
      return failed("email.sending.error.internal_server [code: 10002]");
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.cloudflare_email.account_plan.workers_paid, false);
  assert.equal(summary.cloudflare_email.zones.error, "Unauthorized [code: 2036]");
  assert.equal(summary.cloudflare_email.dns.error, "Unauthorized [code: 2036]");
  assert.equal(
    summary.cloudflare_email.send.error,
    "email.sending.error.internal_server [code: 10002]",
  );
  assert.match(summary.blockers.join("\n"), /requires Workers Paid plan/);
  assert.match(summary.blockers.join("\n"), /zone listing failed/);
  assert.match(summary.blockers.join("\n"), /test send failed/);
  assert.match(summary.next_actions.join("\n"), /enable Workers Paid/);
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

test("email status supports webhook magic link delivery without Cloudflare probes", async () => {
  const commands = [];
  const summary = await emailStatusSummary({
    requireReady: true,
    remote: true,
    sendTest: true,
    live: true,
    config: {
      account_id: "account-123",
      vars: {
        PRODUCT_NAME: "Wavey ID",
        MAGIC_LINK_FROM: "login@wavey.ai",
        MAGIC_LINK_DELIVERY: "webhook",
        MAGIC_LINK_WEBHOOK_URL: "https://mail.wavey.ai/zeroth",
      },
      send_email: [],
    },
    envFileValues: { ADMIN_TOKEN: "admin-token" },
    runCommand: (command, args) => {
      commands.push([command, ...args].join(" "));
      return failed("should not run");
    },
    fetchFn: async (url) => {
      assert.equal(url, "https://id.wavey.ai/local-auth/status");
      return jsonResponse(200, {
        methods: [
          {
            id: "magic_link",
            enabled: true,
            delivery: "webhook",
            notes: [],
            deliveryStatus: {
              lastIssueAt: 1780630448,
              lastSentAt: 1780630448,
            },
          },
        ],
      });
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.ready, true);
  assert.equal(summary.transport.kind, "webhook");
  assert.equal(summary.config.effective_delivery, "webhook");
  assert.equal(summary.cloudflare_email.skipped, "magic link delivery is webhook");
  assert.deepEqual(summary.blockers, []);
  assert.deepEqual(commands, []);
});

test("email status reports webhook configuration blockers", async () => {
  const summary = await emailStatusSummary({
    config: {
      vars: {
        MAGIC_LINK_FROM: "login@wavey.ai",
        MAGIC_LINK_DELIVERY: "webhook",
      },
      send_email: [],
    },
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.transport.kind, "webhook");
  assert.deepEqual(summary.blockers, [
    "MAGIC_LINK_WEBHOOK_URL must be a valid HTTPS URL",
  ]);
  assert.match(summary.next_actions.join("\n"), /MAGIC_LINK_WEBHOOK_URL/);
});

test("email status supports Resend magic link delivery with remote secret", async () => {
  const commands = [];
  const summary = await emailStatusSummary({
    requireReady: true,
    remote: true,
    live: true,
    config: {
      account_id: "account-123",
      vars: {
        MAGIC_LINK_FROM: "login@wavey.ai",
        MAGIC_LINK_DELIVERY: "resend",
      },
      send_email: [],
    },
    envFileValues: { ADMIN_TOKEN: "admin-token" },
    runCommand: (command, args) => {
      commands.push([command, ...args].join(" "));
      assert.deepEqual(args, ["wrangler", "secret", "list", "--config", "wrangler.zeroth.jsonc"]);
      return succeeded('[{"name":"RESEND_API_KEY","type":"secret_text"}]');
    },
    fetchFn: async (url) => {
      assert.equal(url, "https://id.wavey.ai/local-auth/status");
      return jsonResponse(200, {
        methods: [
          {
            id: "magic_link",
            enabled: true,
            delivery: "resend",
            notes: [],
            deliveryStatus: {
              lastIssueAt: 1780630448,
              lastSentAt: 1780630448,
            },
          },
        ],
      });
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.ready, true);
  assert.equal(summary.transport.kind, "resend");
  assert.equal(summary.config.effective_delivery, "resend");
  assert.equal(summary.cloudflare_email.skipped, "magic link delivery is resend");
  assert.deepEqual(summary.provider_secrets.names, ["RESEND_API_KEY"]);
  assert.deepEqual(summary.blockers, []);
  assert.equal(commands.length, 1);
});

test("email status reports MailChannels secret blockers", async () => {
  const summary = await emailStatusSummary({
    remote: true,
    config: {
      vars: {
        MAGIC_LINK_FROM: "login@wavey.ai",
        MAGIC_LINK_DELIVERY: "mailchannels",
      },
      send_email: [],
    },
    runCommand: () => succeeded("[]"),
  });

  assert.equal(summary.ready, false);
  assert.equal(summary.transport.kind, "mailchannels");
  assert.deepEqual(summary.blockers, [
    "MAILCHANNELS_API_KEY or MAGIC_LINK_MAILCHANNELS_API_KEY Worker secret binding is missing",
  ]);
  assert.match(summary.next_actions.join("\n"), /MAILCHANNELS_API_KEY/);
  assert.match(summary.next_actions.join("\n"), /Domain Lockdown/);
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

function succeeded(stdout) {
  return {
    status: 0,
    stdout,
    stderr: "",
  };
}
