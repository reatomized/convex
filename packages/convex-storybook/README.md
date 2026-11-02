# @reatomized/convex-storybook

A Storybook addon for apps on
[`@reatomized/convex`](https://github.com/reatomized/convex/tree/reatom#readme).
Each story gets the fakes from `@reatomized/convex/testing`, built from a typed
`parameters.convex`, and a story that calls a Convex function without a handler
fails.

```sh
npm install -D @reatomized/convex-storybook
```

`storybook` (9 to 11), `@reatomized/convex`, `@reatom/core` and `convex` are
peer dependencies. The addon imports no Storybook runtime.

## Setup

Add the addon to a CSF Next preview:

```tsx
// .storybook/preview.tsx
import convexStorybook, {
  type ConvexStorybookParameters,
} from "@reatomized/convex-storybook";
import { definePreview } from "@storybook/react-vite";
import type { PreviewAddon } from "storybook/internal/csf";
import { storyFrameAddon } from "./storyFrame";

const convexAddon: PreviewAddon<{ parameters: ConvexStorybookParameters }> =
  convexStorybook();

export default definePreview({ addons: [convexAddon, storyFrameAddon] });
```

The addon types `parameters.convex` and fails a story that called a function
without a handler. Handing the fakes to the app takes one line in `.storybook/`,
because only the app knows where it keeps its client and where each story's
Reatom frame starts. Stories touch neither.

A preview without CSF Next adds the annotations from
`@reatomized/convex-storybook/preview` instead.

### Where the app keeps its client

The app reads its client from an atom that production sets too, the Reatom
counterpart of `<ConvexProvider client={convex}>`. Atom state is per frame, so
each story can put its fake there:

```ts
// src/shared/convex.ts
import { assert, atom } from "@reatom/core";
import type { ReatomConvexClient } from "@reatomized/convex";

/** `main.tsx` sets the deployment's client; a story sets its fake. */
export const convexAtom = atom<ReatomConvexClient | null>(null, "convex");

export const convex = (): ReatomConvexClient => {
  const client = convexAtom();
  assert(client, "No Convex client in this frame");
  return client;
};
```

The atom is empty by default, so a story that skips the fakes fails instead of
connecting to the deployment. An app that creates its client at module scope, as
in `export const convex = reatomConvexClient(url)`, moves it into such an atom
once. The demo's `backendAtom` holds the client with its auth state.

### Where the story's frame starts

Stories that don't share atoms each run in their own Reatom frame. The app's
Storybook setup starts it in a loader, for the router and persisted atoms as
much as for Convex, and a decorator passes it to `reatomContext.Provider`. The
addon adds one line to that loader:

```ts
// .storybook/storyFrame.ts
import { context } from "@reatom/core";
import { convexStory } from "@reatomized/convex-storybook";
import type { PreviewAddon } from "storybook/internal/csf";
import { convexAtom } from "../src/shared/convex";

export const storyFrameAddon: PreviewAddon = {
  loaders: [
    (story) => {
      const frame = context.start();
      frame.run(() => {
        convexAtom.set(convexStory(story).convex); // the addon's line
      });
      return { reatomFrame: frame };
    },
  ],
};
```

`convexStory` builds the fakes in the current frame and runs
`parameters.convex.setup` there, so the frame exists by construction. The same
frame gets the same fakes, so a rerender that keeps the frame keeps their state.
The addon can't do this in a loader of its own: Storybook runs a preview's
loaders in parallel and fills `context.loaded` only after all of them, so it
couldn't see the frame the app's loader starts.
[The demo's `storyFrame.ts`](https://github.com/reatomized/convex-demo/blob/use-reatomized-convex/.storybook/storyFrame.ts)
also keeps the frame across rerenders and sets the route.

## Parameters

```ts
parameters: {
  convex: {
    auth: "authenticated", // or "unauthenticated", "loading", "rejected"
    identity: fakeIdentity("alex", { email: "alex@example.com" }),
    setup: ({ convex, provider, auth }, story) => {
      convex.handleQuery(api.notes.list, () => notes());
    },
  },
}
```

- `setup` registers the story's handlers. It runs once per frame, inside it.
- `auth` is the status the story reaches, `authenticated` by default. `loading`
  keeps the auth library restoring its session; `rejected` has the server refuse
  its token.
- `identity` is who signs in, `fakeIdentity("user")` by default. Handlers see it
  as `ctx.identity`.
- The fakes are `convex`, a `reatomConvexClientFake`; `provider`, a
  `reatomAuthProviderFake` signed in as `identity`; and `auth`, the real
  `reatomAuthState(convex, provider)`.

Storybook merges `parameters.convex` per key, so a story can set `auth` or
`identity` and keep the `setup` its meta or preview declares.

## A story

Stories should drive the UI through an actor. Keep atom and model assertions in
unit tests. This example starts as the admin, clicks the visible approval
button, and checks the updated account list. Its meta registers the actor loader
and seeds the admin and pending member through `parameters.convex.setup`, as in
[the demo's Access stories](https://github.com/reatomized/convex-demo/blob/use-reatomized-convex/src/app/integration/Access.stories.tsx):

```tsx
AdminManagesAccounts.test("approves a waiting account", async () => {
  await I.see(heading("Team space").wait());
  await I.click(button("Approve: alex@example.com"));
  await I.see(
    text("alex@example.com").within(role("region", "Approved")).wait(),
  );
  await I.dontSee(text("alex@example.com").within(role("region", "Pending")));
});
```

`I` is a [kahraman](https://github.com/apphane-dev/kahraman) actor. The click
goes through the app's action and the fake mutation, so the test covers the same
path a user takes. Authentication journeys should use the app's sign-in and
sign-out UI. Story tests don't read or write atoms; model and atom assertions
belong in unit tests.

## Missing handlers

A function without a handler throws a `MissingHandlerError` naming it. App code
may catch that throw and render something plausible, such as a toast, so the
addon's `afterEach` also fails the story with every function its fakes missed:

```
The story called Convex functions without fake handlers:
- No fake handler for mutation access:approve. Register one with handleMutation(api.access.approve, ...).
Register them in parameters.convex.setup.
```

Apache-2.0.
