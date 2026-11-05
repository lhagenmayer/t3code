import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { museSubscriptionUsageToLimits, readMuseUsageLimits } from "./accountUsage.ts";
import type { MuseSdkHost, MuseSdkHostOptions } from "./sdk.ts";

const usage = {
  observedAtMs: Date.parse("2026-11-05T12:00:00Z"),
  tier: "test-tier",
  window: {
    usedPercent: 25,
    windowDurationMins: 300,
    resetsAtMs: Date.parse("2026-11-05T15:00:00Z"),
  },
  weekly: { usedPercent: 75, resetsAtMs: Date.parse("2026-11-10T12:00:00Z") },
};

const makeHost = (result: Record<string, unknown>, reject = false): MuseSdkHost => ({
  initializeResult: { grantedCapabilities: [] },
  connection: {
    request: vi.fn(async () => {
      if (reject) throw new Error("private-credential-must-not-escape");
      return result;
    }),
    command: vi.fn(async () => ({})),
    mintCommandId: () => "test-command",
    onNotification: () => {},
    onServerRequest: () => {},
    onProtocolError: () => {},
    closed: new Promise(() => {}),
  },
  exited: new Promise(() => {}),
  close: vi.fn(async () => {}),
});

it("preserves the provider observation time and clamps over-quota values", () => {
  const result = museSubscriptionUsageToLimits({
    ...usage,
    weekly: { ...usage.weekly, usedPercent: 120 },
  });
  expect(result.checkedAt).toBe("2026-11-05T12:00:00.000Z");
  expect(result.windows.map((window) => window.usedPercent)).toEqual([25, 100]);
  expect(result.windows[0]?.windowDurationMins).toBe(300);
});

it.layer(NodeServices.layer)("Muse account usage", (it) => {
  it.effect("reads the native quota without creating a session or starting a model turn", () =>
    Effect.gen(function* () {
      const host = makeHost({ usage });
      const createHost = vi.fn(async (_options: MuseSdkHostOptions) => host);
      const result = yield* readMuseUsageLimits({ binaryPath: "muse" }, createHost);
      expect(createHost.mock.calls[0]?.[0]).toMatchObject({ readOnly: true });
      expect(host.connection.request).toHaveBeenCalledExactlyOnceWith("usage/read", {});
      expect(host.connection.command).not.toHaveBeenCalled();
      expect(host.close).toHaveBeenCalledOnce();
      expect(result.windows.map((window) => window.usedPercent)).toEqual([25, 75]);
      expect(result.checkedAt).toBe("2026-11-05T12:00:00.000Z");
    }),
  );

  it.effect("keeps unobserved allowances absent instead of inventing zero usage", () =>
    Effect.gen(function* () {
      const result = yield* readMuseUsageLimits({ binaryPath: "muse" }, async () => makeHost({}));
      expect(result.windows).toEqual([]);
      expect(result.unavailable).toBeUndefined();
    }),
  );

  it.effect("sanitizes failed or invalid quota reads and closes the native host", () =>
    Effect.gen(function* () {
      for (const [response, reject] of [
        [{ usage: null }, false],
        [{ usage: { ...usage, window: { ...usage.window, usedPercent: -1 } } }, false],
        [{ usage: { ...usage, observedAtMs: Number.POSITIVE_INFINITY } }, false],
        [{}, true],
      ] as const) {
        const host = makeHost(response, reject);
        const result = yield* readMuseUsageLimits({ binaryPath: "muse" }, async () => host);
        expect(result.unavailable).toEqual({
          reason: "probeFailed",
          message: "Muse could not read subscription limits.",
        });
        expect(result.windows).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }
    }),
  );
});
