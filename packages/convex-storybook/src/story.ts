import { context, type RootFrame } from "@reatom/core";
import {
  reatomAuthState,
  type AuthStatus,
  type ReatomAuthState,
} from "@reatomized/convex";
import {
  fakeIdentity,
  reatomAuthProviderFake,
  reatomConvexClientFake,
  type AuthProviderFake,
  type MissingHandlerError,
  type ReatomConvexClientFake,
} from "@reatomized/convex/testing";
import type { UserIdentity } from "convex/server";

/** The fakes {@link convexStory} builds for a story. */
export type ConvexStoryFake = {
  readonly convex: ReatomConvexClientFake;
  /** The auth library. Set `provider.identity` to sign in or out. */
  readonly provider: AuthProviderFake;
  /** `reatomAuthState(convex, provider)`. */
  readonly auth: ReatomAuthState;
};

/** The part of a Storybook story context {@link convexStory} reads. */
export type ConvexStoryContext = {
  readonly parameters: ConvexStorybookParameters & Record<string, unknown>;
  readonly abortSignal: AbortSignal;
};

/** `parameters.convex` of a story. */
export interface ConvexStoryParameters {
  /**
   * The status `auth` reaches: `authenticated` (the default) signs in as
   * `identity`, `loading` keeps the auth library restoring its session, and
   * `rejected` has the server refuse the session's token.
   */
  auth?: AuthStatus;
  /** Who is signed in, `fakeIdentity("user")` by default. */
  identity?: UserIdentity;
  /**
   * Registers the story's handlers. It runs once per Reatom frame, inside it,
   * before `convexStory` returns.
   */
  setup?: (fake: ConvexStoryFake, context: ConvexStoryContext) => void;
}

/** The `parameters` the addon types. */
export interface ConvexStorybookParameters {
  convex?: ConvexStoryParameters;
}

const byFrame = new WeakMap<RootFrame, ConvexStoryFake>();
const bySignal = new WeakMap<AbortSignal, Map<RootFrame, ConvexStoryFake>>();

const createFake = ({
  auth = "authenticated",
  identity = fakeIdentity("user"),
}: ConvexStoryParameters): ConvexStoryFake => {
  const convex = reatomConvexClientFake();
  const provider = reatomAuthProviderFake({
    identity: auth === "unauthenticated" ? null : identity,
    isLoading: auth === "loading",
    fetchToken: auth === "rejected" ? () => Promise.resolve(null) : undefined,
  });
  return { convex, provider, auth: reatomAuthState(convex, provider) };
};

/**
 * The story's fakes, built from `parameters.convex` in the current Reatom
 * frame. Call it where the app creates the story's frame, inside it, and put
 * the fakes where the app keeps its client. The same frame gets the same
 * fakes, so a rerender that keeps the frame keeps its state.
 *
 * ```ts
 * frame.run(() => {
 *   const { convex, auth } = convexStory(story);
 *   backendAtom.set({ convex, auth });
 * });
 * ```
 */
export function convexStory(story: ConvexStoryContext): ConvexStoryFake {
  const frame = context();
  let fake = byFrame.get(frame);
  if (fake === undefined) {
    const parameters = story.parameters.convex ?? {};
    fake = createFake(parameters);
    byFrame.set(frame, fake);
    parameters.setup?.(fake, story);
  }
  const fakes = bySignal.get(story.abortSignal) ?? new Map();
  bySignal.set(story.abortSignal, fakes.set(frame, fake));
  return fake;
}

/** Functions the story's fakes were called without handlers for. */
export const unhandledIn = (signal: AbortSignal): MissingHandlerError[] =>
  Array.from(bySignal.get(signal) ?? [], ([frame, { convex }]) =>
    frame.run(() => [...convex.unhandled]),
  ).flat();
