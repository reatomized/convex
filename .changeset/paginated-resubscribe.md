---
"@reatomized/convex": patch
---

A paginated query read again after its last subscriber left starts over from the
first page. It threw `Cannot read properties of null (reading 'keys')`, for
example on remount or when `withConvexPaginatedQuery` arguments returned to
earlier ones.
