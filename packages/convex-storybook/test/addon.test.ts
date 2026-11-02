import { context, noop, type RootFrame } from "@reatom/core";
import { fakeIdentity } from "@reatomized/convex/testing";
import { makeFunctionReference } from "convex/server";
import { definePreview, type InferTypes } from "storybook/internal/csf";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import convexStorybook, {
  convexStory,
  type ConvexStorybookParameters,
  type ConvexStoryContext,
  type ConvexStoryParameters,
} from "../src/index.js";
import annotations from "../src/preview.js";

const viewer = makeFunctionReference<
  "query",
  Record<string, never>,
  string | null
>("users:viewer");

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

const story = (
  convex?: ConvexStoryParameters,
  abortSignal = new AbortController().signal,
): ConvexStoryContext => ({
  parameters: convex === undefined ? {} : { convex },
  abortSignal,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("convexStorybook", () => {
  test("types parameters.convex in a CSF Next preview", () => {
    const addon = convexStorybook();
    const preview = definePreview({ addons: [addon] });

    expect(addon.afterEach).toBe(annotations.afterEach);
    expect(preview.composed.afterEach).toContain(annotations.afterEach);
    expectTypeOf<
      InferTypes<[typeof addon]>["parameters"]
    >().toEqualTypeOf<ConvexStorybookParameters>();
  });
});

describe("convexStory", () => {
  test("runs setup inside the frame and returns the same fakes for it", () => {
    const frame = context.start();
    const setup = vi.fn<NonNullable<ConvexStoryParameters["setup"]>>(
      ({ convex }) =>
        convex.handleQuery(viewer, (_args, { identity }) =>
          identity ? identity.subject : null,
        ),
    );
    const context1 = story({ setup });
    const fake = frame.run(() => convexStory(context1));
    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(fake, context1);
    expect(frame.run(() => convexStory(story({ setup })))).toBe(fake);
    expect(setup).toHaveBeenCalledOnce();

    const other: RootFrame = context.start();
    expect(other.run(() => convexStory(story({ setup })))).not.toBe(fake);
    expect(setup).toHaveBeenCalledTimes(2);
  });

  test("signs in as the story's identity by default", async () => {
    const frame = context.start();
    const { convex, auth } = frame.run(() =>
      convexStory(
        story({
          identity: fakeIdentity("alex"),
          setup: ({ convex }) =>
            convex.handleQuery(viewer, (_args, { identity }) =>
              identity ? identity.subject : null,
            ),
        }),
      ),
    );
    frame.run(() => auth.status.subscribe(noop));
    await settle();
    frame.run(() => {
      expect(auth.status()).toBe("authenticated");
      expect(convex.query(viewer, {}).data()).toBe("alex");
    });
  });

  test.each(["unauthenticated", "loading", "rejected"] as const)(
    "reaches auth: %s",
    async (status) => {
      const frame = context.start();
      const { auth } = frame.run(() => convexStory(story({ auth: status })));
      frame.run(() => auth.status.subscribe(noop));
      await settle();
      expect(frame.run(() => auth.status())).toBe(status);
    },
  );

  test("signs out through the provider", async () => {
    const frame = context.start();
    const { auth, provider, convex } = frame.run(() => convexStory(story()));
    frame.run(() => auth.status.subscribe(noop));
    await settle();
    frame.run(() => provider.identity.set(null));
    await settle();
    frame.run(() => {
      expect(auth.status()).toBe("unauthenticated");
      expect(convex.identity()).toBeNull();
    });
  });
});

describe("afterEach", () => {
  test("fails a story whose fakes ran into a missing handler", async () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    const frame = context.start();
    const signal = new AbortController().signal;
    const { convex } = frame.run(() => convexStory(story({}, signal)));

    expect(() => annotations.afterEach({ abortSignal: signal })).not.toThrow();
    expect(() => frame.run(() => convex.query(viewer, {}).data())).toThrow();
    expect(() => annotations.afterEach({ abortSignal: signal })).toThrow(
      [
        "The story called Convex functions without fake handlers:",
        "- No fake handler for query users:viewer. Register one with handleQuery(api.users.viewer, ...).",
        "Register them in parameters.convex.setup.",
      ].join("\n"),
    );
    expect(() =>
      annotations.afterEach({ abortSignal: new AbortController().signal }),
    ).not.toThrow();
  });
});
