---
"@reatomized/convex": minor
---

Add Reatom extensions over the client's calls. `withConvexQuery` and
`withConvexPaginatedQuery` subscribe an atom whose state is the query's
arguments, or `"skip"`, with `keepPreviousData` to hold the last value while new
arguments load. `withConvexMutation`, `withConvexAction` and `withConvexQuery`
make an action that returns the function's arguments call it, or read the query
once, with `withAsync`'s state. `updateQuery` turns a query atom into a typed
optimistic update, page by page for paginated queries.

`reatomConvexClientFake` applies a mutation's optimistic update while its
handler's promise is pending, replaying it over what the query handlers return.
