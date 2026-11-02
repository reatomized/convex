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

const convexAddon: PreviewAddon<{ parameters: ConvexStorybookParameters }> =
  convexStorybook();

export default definePreview({ addons: [convexAddon, storyFrameAddon] });
```

The addon doesn't install the fakes, because only the app knows where its Reatom
frame starts and where it keeps its client. Call `convexStory(story)` inside the
story's frame, where the app would put its real backend:

```ts
// .storybook/storyFrame.ts, a loader that starts the story's frame
import { convexStory } from "@reatomized/convex-storybook";

const frame = context.start();
frame.run(() => {
  const { convex, auth } = convexStory(story);
  backendAtom.set({ convex, auth });
  urlAtom.go(story.parameters.initialPath ?? "");
});
```

`convexStory` builds the fakes in the current frame and runs
`parameters.convex.setup` there, so the frame exists by construction. The same
frame gets the same fakes, so a rerender that keeps the frame keeps their state.
Storybook runs a preview's loaders in parallel and fills `context.loaded` only
after all of them, so an addon loader couldn't see a frame another loader
starts, and some apps start their frame in a decorator.

A preview without CSF Next adds the annotations from
`@reatomized/convex-storybook/preview` instead.

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

`I` is a [kahraman](https://github.com/apphane-dev/kahraman) actor. Actor-only
tests need no frame wrapper. The click goes through the app's action and the
fake mutation, so the test covers the same path a user takes. Authentication
journeys should use the app's sign-in and sign-out UI.

Keep `inStoryFrame` internal to app-specific test infrastructure. A test needs
it only when that infrastructure must read or write atoms, such as simulating a
connection change with no UI control. Model and atom assertions belong in unit
tests.

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
