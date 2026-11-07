---
"@reatomized/convex": patch
---

`reatomBetterAuthProvider`'s `fetchToken` returns a token request already in
flight for the session before its cached token, as `ConvexBetterAuthProvider`
does, so a fetch during a refresh gets the new token rather than the one the
server rejected.
