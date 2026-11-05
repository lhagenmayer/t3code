import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { MuseSubscriptionUsage } from "./protocol.ts";
import { createMuseSdkHost, createMuseSdkHostEffect, type MuseSdkHostOptions } from "./sdk.ts";

const decodeUsageRead = Schema.decodeUnknownEffect(
  Schema.Struct({ usage: Schema.optional(MuseSubscriptionUsage) }),
);
class MuseUsageReadError extends Schema.TaggedError<
  MuseUsageReadError,
  { readonly brand: unique symbol }
>()("MuseUsageReadError", {
  cause: Schema.Defect(),
}) {}

export function museSubscriptionUsageToLimits(
  usage: MuseSubscriptionUsage,
): ServerProviderUsageLimits {
  return makeUsageLimits({
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: clampPercent(usage.window.usedPercent),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(usage.window.resetsAtMs)),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(usage.weekly.resetsAtMs)),
      },
    ],
  });
}

export const readMuseUsageLimits = Effect.fn("readMuseUsageLimits")(function* (
  options: Pick<MuseSdkHostOptions, "binaryPath" | "environment" | "cwd">,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const host = yield* Effect.acquireRelease(
        createMuseSdkHostEffect(
          { ...options, readOnly: true, startupTimeoutMs: 5_000 },
          createHost,
        ),
        (host) => Effect.promise(() => host.close()),
        { interruptible: true },
      );
      const result = yield* Effect.tryPromise({
        try: () => host.connection.request("usage/read", {}),
        catch: (cause) => new MuseUsageReadError({ cause }),
      }).pipe(Effect.timeout("5 seconds"), Effect.flatMap(decodeUsageRead));
      return result.usage
        ? museSubscriptionUsageToLimits(result.usage)
        : makeUsageLimits({ checkedAt, windows: [] });
    }),
  ).pipe(
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Muse could not read subscription limits.",
      }),
    ),
  );
});
