---
"@reatomized/convex": minor
---

Add Reatom extensions over the client's calls: `withConvexQuery` and
`withConvexPaginatedQuery` subscribe an atom whose state is the query's
arguments, or `"skip"`, and `withConvexMutation` and `withConvexAction` make an
action that returns the function's arguments call it, with `withAsync`'s state.
