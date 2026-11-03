# @reatomized/convex

A [Convex](https://convex.dev) sync client whose state lives in
[Reatom](https://github.com/reatom/reatom) v1001 atoms: queries, paginated
queries, the connection and auth. It replaces `convex/browser`'s WebSocket
client and nothing else, so keep the `convex` package for your functions, the
CLI and codegen.

```sh
npm install @reatomized/convex convex @reatom/core
```

`convex` and `@reatom/core` are peer dependencies. The client takes function
references and `ConvexError` from your `convex`, and its atoms live in your
app's Reatom context. It speaks the sync protocol of convex 1.49.0.

## Usage

```ts
import { reatomConvexClient } from "@reatomized/convex";
import { atom, computed } from "@reatom/core";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const convex = reatomConvexClient(import.meta.env.VITE_CONVEX_URL);

const noteId = atom<Id<"notes"> | null>(null, "noteId");
const note = computed(() => {
  const id = noteId();
  return id ? convex.query(api.notes.get, { id }).data() : undefined;
}, "note");
```

- `convex.query(ref, args)` returns the entry for that function and arguments,
  the same object for equal arguments. Its `result`, `data`, `error` and
  `status` are atoms. Reading one in a subscribed graph subscribes the query on
  the server; once nothing reads it, the query is unsubscribed.
- Query set changes made in one microtask go out as one `ModifyQuerySet`. In the
  example above, changing `noteId` sends one message that adds the new query and
  removes the old one.
- `convex.paginatedQuery(ref, args, { initialNumItems })` has `results`,
  `status` and `error` atoms and a `loadMore` action. Equal arguments share
  their pages; pass `id` for a separate page list.
- `convex.mutation(ref, args, { optimisticUpdate })` and
  `convex.action(ref, args)` return promises and run as Reatom actions. A failed
  call rejects with a `ConvexError` from `convex/values` when the function threw
  one.
- `connectionState`, `isAuthenticated` (`null` while a token waits for the
  server), `isRefreshingAuth`, `authClaims` and `socketState` are atoms.
  `setAuth`, `clearAuth` and `close` are actions.

State is per Reatom context: call the client inside a frame, and each context
gets its own connection. The socket opens on first use in a context.

There are no React hooks. Read the atoms through your Reatom view binding, such
as `@reatom/react` or `@reatom/jsx`.

## Extensions

The same calls as Reatom extensions, for models built from atoms and actions. An
atom whose state is a query's arguments gets the query's state; an action that
returns a function's arguments calls the function:

```ts
import {
  withConvexMutation,
  withConvexPaginatedQuery,
  withConvexQuery,
} from "@reatomized/convex";
import { action, atom, computed, wrap } from "@reatom/core";

const note = computed(() => {
  const id = noteId();
  return id ? { id } : "skip";
}, "note").extend(withConvexQuery(convex, api.notes.get));
note.data(); // also error, status, ready and query

const notes = atom({}, "notes").extend(
  withConvexPaginatedQuery(convex, api.notes.list, { initialNumItems: 10 }),
);
notes.results(); // also status, error, loadMore and query

const addNote = action((text: string) => ({ text }), "addNote").extend(
  withConvexMutation(convex, api.notes.add, {
    optimisticUpdate: (store, { text }) => {
      /* ... */
    },
  }),
);
await wrap(addNote("Hello")); // the mutation's result
addNote.ready(); // and the rest of withAsync
```

- `withConvexQuery(client, ref, options)` adds `data`, `error`, `status`,
  `ready` and `query`, the `convex.query` entry for the current arguments. Equal
  arguments share one entry. When the arguments change, the new query replaces
  the old one in one `ModifyQuerySet`. `"skip"` subscribes nothing: `status` is
  `skipped`, `ready` is true and `query` is `undefined`.
- `withConvexPaginatedQuery(client, ref, { initialNumItems, id })` takes the
  arguments without `paginationOpts` and adds `results`, `status`, `error`,
  `loadMore` and `query`. While skipped, `results` is empty and `status` is
  `Skipped`.
- `withConvexMutation(client, ref, { optimisticUpdate, ...asyncOptions })` and
  `withConvexAction(client, ref, asyncOptions)` make the action return the
  function's promise and apply `withAsync` to it. The callback may return a
  promise of the arguments, or nothing when every argument is optional. The
  optimistic update receives the mutation's arguments.
- `client` is a client, or a function that returns one, such as an atom that
  holds it. The query extensions call it in their computeds, so they follow a
  client that changes, and the call extensions call it on every call.
- The atom's state and the action's return value are checked against the
  function's arguments. Like Reatom's own extensions, a query atom whose state
  doesn't fit gets a `withConvexQuery_ERROR` property instead of the query
  atoms.

The extensions create their atoms on first read, and `data` and `status` read
the query's result directly, so an update recomputes as many atoms as reading
`convex.query(ref, args).data` does. They only call the client, so they work
with `reatomConvexClientFake()` too.

## Auth

`reatomAuthState(convex, provider)` does what convex/react's
`ConvexProviderWithAuth` and `useConvexAuth` do. An auth library reports whether
it is loading and who is signed in, `reatomAuthState` sends that session's
token, and its `status` turns `authenticated` once the server accepts the token.
`status` is `loading`, `unauthenticated`, `authenticated` or `rejected`;
`isLoading`, `isAuthenticated` and `isRefreshing` are atoms too. The client
follows the provider while one of these atoms has a subscriber, so subscribe to
one at the root of the app.

Two entry points build the provider from an auth library:

```ts
// Convex Auth (@convex-dev/auth)
import { reatomConvexAuthProvider } from "@reatomized/convex/convex-auth";

const convexAuth = reatomConvexAuthProvider(convex);
const auth = reatomAuthState(convex, convexAuth);
await convexAuth.signIn("password", { email, password, flow: "signIn" });
await convexAuth.signIn("github"); // navigates to GitHub
await convexAuth.signOut();
```

`reatomConvexAuthProvider` implements the client side of `@convex-dev/auth`,
whose own client is a React provider. It uses the same storage keys, so sessions
carry over from `@convex-dev/auth/react`. On start it signs in with a `code`
from the URL, and it refreshes the token once across tabs.
`completeSignIn(code)` runs that exchange for an app that reads the URL itself;
its `error` atom holds a failed exchange either way.

```ts
// Better Auth with @convex-dev/better-auth
import { reatomBetterAuthProvider } from "@reatomized/convex/better-auth";
import {
  convexClient,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";

const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL,
  plugins: [convexClient(), crossDomainClient()],
});
const auth = reatomAuthState(convex, reatomBetterAuthProvider(authClient));
await authClient.signIn.email({ email, password });
```

Better Auth's client works without a framework, so you sign in through it;
`reatomBetterAuthProvider` follows its session store, fetches Convex tokens, and
trades the `ott` one-time token from a cross-domain OAuth redirect for the
session. Its `data` atom is the store's session and user, typed by your client,
and `completeSignIn(ott)` is the one-time token trade with an `error` atom.
Neither entry point adds dependencies.

For another library, pass any object with `isLoading` and `session` atoms and a
`fetchToken` function. `session` should change when the identity does, such as a
user or organization id. Pass an atom of providers to switch libraries at
runtime.

## Testing

`@reatomized/convex/testing` has fakes for UI tests and stories, with no
deployment and no socket. `reatomConvexClientFake()` is a `ReatomConvexClient`
whose functions are handlers, registered per function reference with types from
it:

```ts
import { loading, reatomConvexClientFake } from "@reatomized/convex/testing";
import { atom } from "@reatom/core";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";

const convex = reatomConvexClientFake();
const notes = atom<string[]>([], "notes");
const ready = atom(true, "ready");

convex.handleQuery(api.notes.list, () => (ready() ? notes() : loading));
convex.handleMutation(api.notes.add, ({ text }, { identity }) => {
  if (!identity) throw new ConvexError("Not authenticated");
  notes.set((all) => [...all, text]);
  return null;
});
```

- Query handlers run inside computeds. A handler that reads atoms runs again
  when they change, and a mutation handler that writes them updates every query
  that reads them.
- Returning `loading` keeps a query loading. A handler that throws fails the
  query with that error in `error`, so a `ConvexError` keeps its `data`. Query
  handlers are synchronous; mutation and action handlers may return promises.
- Results go through `convexToJson`, as on the wire: `undefined` arrives as
  `null`, and a value Convex can't send fails the call.
- A function without a handler throws `MissingHandlerError` naming it: on read
  for a query, at the call for a mutation or action. App code may catch that
  throw, so the fake also logs it with `console.error` and lists it in
  `unhandled`.
- The second argument of a handler is `{ identity }`, like
  `ctx.auth.getUserIdentity()`. `setAuth` takes it from the token's claims;
  `identity` is also settable.
- `paginatedQuery` pages through a query handler's results;
  `paginate(items, paginationOpts)` cuts a page from an array.
- `connected` and `isRefreshingAuth` set what the client reports.
- Handlers and state are per Reatom context, like the real client's. Register
  handlers inside the frame that uses them.

For auth, `reatomAuthProviderFake({ identity })` is an auth library for the real
`reatomAuthState(convex, provider)`: its token carries `identity`, so the
handlers see who signed in, and setting `provider.identity` signs in or out. Use
it to run the app's own auth state. `reatomAuthStateFake(status)` returns the
shape `reatomAuthState` returns with a settable `status`, for code that takes an
auth state and should show `loading` or `rejected` without a client.

For Storybook,
[`@reatomized/convex-storybook`](https://github.com/reatomized/convex/tree/reatom/packages/convex-storybook#readme)
builds these fakes per story from typed `parameters.convex`.

## Node

With `@reatom/core@1001.3.0` loaded, Node never exits on its own, so a script
that uses this client hangs after its work is done. The fix is on Reatom's
`v1001` branch; install that build in projects with such scripts (npm 12
installs from a URL only with `--allow-remote`):

```sh
npm install --allow-remote=root @reatom/core@https://pkg.pr.new/@reatom/core@5f42184
```

Convex 1.49.0 requires Node 22 or later, which has a global `WebSocket`.

## Differences from convex/browser 1.48.0

- Query set changes are batched per microtask instead of sent one per subscribe
  and unsubscribe.
- A transition updates the queries it names. Optimistic updates replay only
  while some are pending. convex/browser rebuilds and diffs every result on each
  transition, which makes mounting N queries cost O(N²).
- `clearAuth` stops the auth flow. In convex/browser a refetch scheduled before
  `clearAuth` still runs and can authenticate the old session again.
- When a token fetch returns `null` for a signed-in client, the client sends the
  server `Authenticate` without a token. convex/browser drops that message while
  the socket is paused for the fetch, so the server keeps the old identity.
- With `expectAuth`, a socket that opened before the first token sends `Connect`
  once the token arrives. convex/browser never sends it, and `hasEverConnected`
  stays false.
- A failed page of a paginated query lands in its `error` atom. In
  convex/browser it throws out of the WebSocket message handler.
- Server results stay visible across a reconnect until the new connection
  answers.
- Minified, the client is 13.8 KiB gzip, or 19.0 KiB with the parts of
  `convex/values` and `convex/server` it uses, against 15.8 KiB for
  convex/browser's `BaseConvexClient`. The Reatom functions it uses add 4.6 KiB,
  shared with the rest of the app.

With 1000 components each running its own query in Chromium and @reatom/jsx
rendering, mounting takes 6.28 ms against 54.2 ms for convex/react, unmounting
0.75 ms against 7.93 ms.
[CONTRIBUTING.md](https://github.com/reatomized/convex/blob/reatom/CONTRIBUTING.md#performance)
has the full table and how it was measured.

## Development

The repository is a fork of
[convex/convex-js](https://github.com/convex/convex-js) cut down to this client
and the upstream sync helpers it reuses. Server and value utilities are imported
directly from the official `convex` peer in both source and builds.
[CONTRIBUTING.md](https://github.com/reatomized/convex/blob/reatom/CONTRIBUTING.md)
covers the layout, the parity tests against upstream's client, syncing with
upstream, and releases.

Apache-2.0, like convex-js.
