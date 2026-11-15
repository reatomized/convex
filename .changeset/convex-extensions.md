---
"@reatomized/convex": minor
---

Add optional Reatom extensions over the client's calls. `withConvexQuery` and
`withConvexPaginatedQuery` subscribe an atom whose state is the query's
arguments, or `"skip"`, with `keepPreviousData` to hold the last value while new
arguments load. `withConvexMutation`, `withConvexAction` and `withConvexQuery`
make an action that returns the function's arguments call it, or read the query
once, with `withAsync`'s state; an abort of a one-shot read unsubscribes its
query. `updateQuery` turns a query atom into a typed optimistic update, page by
page for paginated queries, bound to the atom's arguments when the action is
called.

`reatomConvexClientFake` shows a mutation's optimistic update until its
handler's promise settles, as the real client does until the server answers.
That includes queries opened during that time.
