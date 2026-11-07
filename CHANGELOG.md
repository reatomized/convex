# @reatomized/convex

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
