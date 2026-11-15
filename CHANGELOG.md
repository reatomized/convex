# @reatomized/convex

## 0.5.0

### Minor Changes

- a9e9c4d: Add optional Reatom extensions over the client's calls.
  `withConvexQuery` and `withConvexPaginatedQuery` subscribe an atom whose state
  is the query's arguments, or `"skip"`, with `keepPreviousData` to hold the
  last value while new arguments load. `withConvexMutation`, `withConvexAction`
  and `withConvexQuery` make an action that returns the function's arguments
  call it, or read the query once, with `withAsync`'s state; an abort of a
  one-shot read unsubscribes its query. `updateQuery` turns a query atom into a
  typed optimistic update, page by page for paginated queries, bound to the
  atom's arguments when the action is called.

  `reatomConvexClientFake` shows a mutation's optimistic update until its
  handler's promise settles, as the real client does until the server answers.
  That includes queries opened during that time.

## 0.4.1

### Patch Changes

- 7b00fa0: `reatomBetterAuthProvider`'s `fetchToken` returns a token request
  already in flight for the session before its cached token, as
  `ConvexBetterAuthProvider` does, so a fetch during a refresh gets the new
  token rather than the one the server rejected.
- 422f2cf: `reatomBetterAuthProvider` keys Convex tokens by session, as
  `@convex-dev/better-auth` 0.13's `ConvexBetterAuthProvider` does. A token
  request started for one session no longer answers or caches for the next. An
  `initialToken` stands for the session in its `sessionId` claim: it isn't used
  for another session, and loading its own session keeps it without
  re-authenticating.

  `reatomConvexClientFake`'s error for a handler result Convex can't send
  carries the original error as its `cause`.

## 0.4.0

### Minor Changes

- 7228b01: Add reactive client and auth fakes under
  `@reatomized/convex/testing`, and the `@reatomized/convex-storybook` addon for
  typed story handlers and per-frame setup. Missing handlers fail stories even
  when the app catches the error.
