---
"@reatomized/convex": patch
---

`reatomBetterAuthProvider` keys Convex tokens by session, as
`@convex-dev/better-auth` 0.13's `ConvexBetterAuthProvider` does. A token
request started for one session no longer answers or caches for the next. An
`initialToken` stands for the session in its `sessionId` claim: it isn't used
for another session, and loading its own session keeps it without
re-authenticating.

`reatomConvexClientFake`'s error for a handler result Convex can't send carries
the original error as its `cause`.
