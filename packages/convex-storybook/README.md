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
  `reatomAuthState(convex, provider)`. Setting `provider.identity` in a test
  signs in or out.

Storybook merges `parameters.convex` per key, so a story can set `auth` or
`identity` and keep the `setup` its meta or preview declares.

## A story

The access gate in
[convex-demo](https://github.com/reatomized/convex-demo/blob/main/src/app/integration/Access.stories.tsx):
a waiting account sees the waiting page, the admin approves it, and the team
space opens. The members table is an atom, so its state is per story frame, and
the approve handler updates the queries that read it.

```tsx
import { atom, wrap } from "@reatom/core";

const alex = {
  _id: "alex" as Id<"members">,
  email: "alex@example.com",
  role: "member",
  approved: false,
};
const olga = {
  _id: "olga" as Id<"members">,
  email: "olga@example.com",
  role: "admin",
  approved: true,
};
const asAlex = fakeIdentity("alex", { email: alex.email });
const asOlga = fakeIdentity("olga", { email: olga.email });

const members = atom<Member[]>([], "story.members");
const accessOf = ({ role, approved }: Member) =>
  role === "admin" ? "admin" : approved ? "approved" : "pending";

const meta = preview.meta({
  component: App,
  parameters: {
    initialPath: "team",
    convex: {
      identity: asAlex,
      setup: ({ convex }) => {
        members.set([olga, alex]);
        convex.handleQuery(api.access.viewer, (_args, { identity }) => {
          const record = members().find((m) => m.email === identity?.email);
          return record ? accessOf(record) : null;
        });
        convex.handleQuery(api.access.members, () => ({
          pending: members().filter((m) => m.role === "member" && !m.approved),
          approved: members().filter((m) => m.role === "member" && m.approved),
        }));
        convex.handleMutation(api.access.approve, ({ memberId }) => {
          members.set((all) =>
            all.map((m) => (m._id === memberId ? { ...m, approved: true } : m)),
          );
          return null;
        });
      },
    },
  },
  loaders: [(ctx) => I.init(ctx)],
});
export default meta;

export const WaitsForApproval = meta.story();

WaitsForApproval.test(
  "opens the team space once the admin approves",
  inStoryFrame(async ({ provider }) => {
    await wrap(I.see(heading("Waiting for approval").wait()));

    // The admin signs in on the same device and approves the account.
    provider.identity.set(asOlga);
    await wrap(I.click(button("Approve: alex@example.com").wait()));

    provider.identity.set(asAlex);
    await wrap(I.see(heading("Team space").wait()));
  }),
);
```

`I` is a [kahraman](https://github.com/apphane-dev/kahraman) actor, and the
click goes through the app's approve action and the fake's mutation.
`inStoryFrame` runs a test in the story's frame and hands it the fakes; the same
frame returns the same fakes:

```ts
const inStoryFrame =
  (fn: (fake: ConvexStoryFake) => Promise<void>) =>
  (story: ConvexStoryContext & { loaded: Record<string, unknown> }) =>
    storyFrame(story).run(() => fn(convexStory(story)));
```

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
