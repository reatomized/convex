---
"@reatomized/convex": minor
---

`withConvexMutation`'s `optimisticUpdate` types the mutation's arguments in
`updateQuery` on TypeScript 6 and 7, which typed them `any`. Breaking:
`optimisticUpdate` no longer takes a bare `(store, args) => void` function; wrap
it in the new `updateStore`:

```ts
withConvexMutation(convex, api.notes.add, {
  optimisticUpdate: updateStore((store, { text }) => {
    // ...
  }),
});
```
