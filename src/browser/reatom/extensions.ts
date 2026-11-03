/**
 * Reatom extensions that bind atoms and actions to Convex functions.
 *
 * `withConvexQuery` and `withConvexPaginatedQuery` go on an atom whose state is
 * the query's arguments, or `"skip"`, and add the query's state to it.
 * `withConvexMutation` and `withConvexAction` go on an action that returns the
 * function's arguments; the action then calls the function and returns its
 * promise, with `withAsync`'s state.
 *
 * Each extension takes the client, or a function that returns it, which it
 * calls when it needs the client: inside the computeds for queries, and on each
 * call for mutations and actions.
 */
import {
  action,
  computed,
  withActionMiddleware,
  withAsync,
  wrap,
  type Action,
  type AsyncExt,
  type AsyncOptions,
  type AtomLike,
  type AtomState,
  type Computed,
} from "@reatom/core";
import type { OptimisticLocalStore } from "convex/browser";
import type { PaginationStatus } from "../sync/pagination.js";
import type {
  ActionRef,
  ArgsOf,
  MutationRef,
  PaginatedItemOf,
  QueryRef,
  QueryStatus,
  ReatomConvexClient,
  ReatomQuery,
  ReatomQueryOptions,
  ReturnOf,
} from "./client.js";
import type { ReatomPaginatedQuery } from "./paginated.js";

/**
 * A client, or a function that returns one. A function is called each time the
 * client is needed, so it can read an atom that holds the client.
 *
 * @public
 */
export type ConvexClientSource =
  | ReatomConvexClient
  | (() => ReatomConvexClient);

const clientOf = (source: ConvexClientSource): ReatomConvexClient =>
  typeof source === "function" ? source() : source;

/**
 * Defines each of `atoms` on `target` as a getter that creates the atom on its
 * first read, as the client's query entries do. An app with many query atoms
 * then builds only the ones it reads, and returning the target keeps
 * `extend` from reading them all.
 */
const defineLazy = <Target extends AtomLike>(
  target: Target,
  atoms: Record<string, () => unknown>,
): Target => {
  for (const [key, create] of Object.entries(atoms)) {
    if (key in target) {
      throw new Error(`${target.name} already has ${key}`);
    }
    let created: unknown;
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => (created ??= create()),
    });
  }
  return target;
};

/**
 * The status of an atom extended with {@link withConvexQuery}: the query's
 * status, or `skipped` while the atom holds `"skip"`.
 *
 * @public
 */
export type ConvexQueryStatus = QueryStatus | "skipped";

/**
 * What {@link withConvexQuery} adds to an atom.
 *
 * @public
 */
export interface ConvexQueryExt<T> {
  /** The query for the atom's arguments, `undefined` while it holds `"skip"`. */
  readonly query: Computed<ReatomQuery<T> | undefined>;
  /** The value, `undefined` while loading, skipped or after an error. */
  readonly data: Computed<T | undefined>;
  /** The error the query failed with, a `ConvexError` when it carries data. */
  readonly error: Computed<Error | undefined>;
  readonly status: Computed<ConvexQueryStatus>;
  /** Whether the query is not loading: it has a result or is skipped. */
  readonly ready: Computed<boolean>;
}

/**
 * Subscribes the atom's state, the arguments of `query`, while one of the
 * atoms this adds is read in a subscribed graph. When the arguments change,
 * the query for the new ones replaces the old one in the same query set
 * change. `"skip"` subscribes nothing.
 *
 * ```ts
 * const note = computed(
 *   () => (noteId() ? { id: noteId()! } : "skip"),
 *   "note",
 * ).extend(withConvexQuery(convex, api.notes.get));
 *
 * note.data(); // the note, `undefined` while loading
 * ```
 *
 * @param client - The client, or a function that returns it.
 * @param query - A query reference, or a function path.
 *
 * @public
 */
export function withConvexQuery<Query extends QueryRef>(
  client: ConvexClientSource,
  query: Query,
  options?: ReatomQueryOptions,
): <Target extends AtomLike>(
  target: Target,
) => [AtomState<Target>] extends [ArgsOf<Query> | "skip"]
  ? ConvexQueryExt<ReturnOf<Query>>
  : {
      withConvexQuery_ERROR: "The atom's state should be the query's arguments or \"skip\"";
    } {
  type T = ReturnOf<Query>;
  return ((target: AtomLike) => {
    let entry: Computed<ReatomQuery<T> | undefined> | undefined;
    // Equal arguments read the same entry, so it changes only with them.
    const entryOf = () =>
      (entry ??= computed((): ReatomQuery<T> | undefined => {
        const args = target();
        return args === "skip"
          ? undefined
          : clientOf(client).query(query, args, options);
      }, `${target.name}.query`));
    // `data` and `status` read the entry's result, not its computeds, so an
    // update recomputes as many atoms as reading the entry directly.
    const ext: ConvexQueryExt<T> = defineLazy(target, {
      query: entryOf,
      data: () =>
        computed((): T | undefined => {
          const result = entryOf()()?.result();
          return result?.success ? (result.value as T) : undefined;
        }, `${target.name}.data`),
      error: () => computed(() => entryOf()()?.error(), `${target.name}.error`),
      status: () =>
        computed((): ConvexQueryStatus => {
          const current = entryOf()();
          if (current === undefined) return "skipped";
          const result = current.result();
          return result === undefined
            ? "loading"
            : result.success
              ? "success"
              : "error";
        }, `${target.name}.status`),
      ready: () =>
        computed(() => ext.status() !== "loading", `${target.name}.ready`),
    }) as any;
    return ext;
  }) as any;
}

/**
 * The status of an atom extended with {@link withConvexPaginatedQuery}: the
 * pagination status, or `Skipped` while the atom holds `"skip"`.
 *
 * @public
 */
export type ConvexPaginatedQueryStatus = PaginationStatus | "Skipped";

/**
 * What {@link withConvexPaginatedQuery} adds to an atom.
 *
 * @public
 */
export interface ConvexPaginatedQueryExt<Item> {
  /**
   * The paginated query for the atom's arguments, `undefined` while it holds
   * `"skip"`.
   */
  readonly query: Computed<ReatomPaginatedQuery<Item> | undefined>;
  /** The items of the loaded pages, empty while skipped. */
  readonly results: Computed<Item[]>;
  readonly status: Computed<ConvexPaginatedQueryStatus>;
  /** The error a page failed with. */
  readonly error: Computed<Error | undefined>;
  /**
   * Load `numItems` more items. Returns whether a page load started: not while
   * a page loads, once the query is exhausted, or while skipped.
   */
  readonly loadMore: Action<[numItems: number], boolean>;
}

/**
 * Options for {@link withConvexPaginatedQuery}.
 *
 * @public
 */
export type ConvexPaginatedQueryOptions = {
  /** The size of the first page. */
  initialNumItems: number;
  /** Queries with equal arguments and `id` share their pages; `-1` by default. */
  id?: number;
};

const NO_RESULTS: never[] = [];

/** The arguments of a paginated query without `paginationOpts`. */
type PaginatedArgsOf<Query> = Omit<ArgsOf<Query>, "paginationOpts">;

/**
 * Subscribes the pages of `query` for the atom's state, its arguments without
 * `paginationOpts`, while one of the atoms this adds is read in a subscribed
 * graph. When the arguments change, the pages start over from the first one.
 * `"skip"` subscribes nothing.
 *
 * ```ts
 * const notes = atom({}, "notes").extend(
 *   withConvexPaginatedQuery(convex, api.notes.list, { initialNumItems: 10 }),
 * );
 *
 * notes.results(); // the loaded notes
 * notes.loadMore(10);
 * ```
 *
 * @param client - The client, or a function that returns it.
 * @param query - A paginated query reference, or a function path.
 *
 * @public
 */
export function withConvexPaginatedQuery<Query extends QueryRef>(
  client: ConvexClientSource,
  query: Query,
  options: ConvexPaginatedQueryOptions,
): <Target extends AtomLike>(
  target: Target,
) => [AtomState<Target>] extends [PaginatedArgsOf<Query> | "skip"]
  ? ConvexPaginatedQueryExt<PaginatedItemOf<Query>>
  : {
      withConvexPaginatedQuery_ERROR: "The atom's state should be the query's arguments without paginationOpts, or \"skip\"";
    } {
  type Item = PaginatedItemOf<Query>;
  return ((target: AtomLike) => {
    let entry: Computed<ReatomPaginatedQuery<Item> | undefined> | undefined;
    const paginated = () =>
      (entry ??= computed((): ReatomPaginatedQuery<Item> | undefined => {
        const args = target();
        return args === "skip"
          ? undefined
          : clientOf(client).paginatedQuery(query, args, options);
      }, `${target.name}.query`));
    return defineLazy(target, {
      query: paginated,
      results: () =>
        computed(
          (): Item[] => paginated()()?.results() ?? NO_RESULTS,
          `${target.name}.results`,
        ),
      status: () =>
        computed(
          (): ConvexPaginatedQueryStatus =>
            paginated()()?.status() ?? "Skipped",
          `${target.name}.status`,
        ),
      error: () =>
        computed(() => paginated()()?.error(), `${target.name}.error`),
      loadMore: () =>
        action(
          (numItems: number) => paginated()()?.loadMore(numItems) ?? false,
          `${target.name}.loadMore`,
        ),
    });
  }) as any;
}

/**
 * What an action may return for a function with these arguments: the
 * arguments, a promise of them, or nothing when every argument is optional.
 *
 * @public
 */
export type ConvexCallArgs<Args> =
  | Args
  | Promise<Args>
  | ({} extends Args ? void | Promise<void> : never);

/**
 * An action extended with {@link withConvexMutation} or
 * {@link withConvexAction}: it returns the function's promise and has
 * `withAsync`'s state. Properties other extensions added stay.
 *
 * @public
 */
export type ConvexCallAction<Target, Payload, Err> =
  Target extends Action<infer Params, any>
    ? Action<Params, Promise<Payload>> &
        AsyncExt<Params, Payload, Err> & {
          [K in Exclude<keyof Target, keyof Action>]: Target[K];
        }
    : never;

/**
 * Options for {@link withConvexMutation}: an optimistic update and the options
 * of `withAsync`.
 *
 * @public
 */
export type ConvexMutationOptions<
  Args,
  Err = Error,
  EmptyErr = undefined,
> = AsyncOptions<Err, EmptyErr> & {
  /**
   * Locally updates queries while the mutation is pending, called with the
   * mutation's arguments. It is rolled back once the mutation is reflected.
   */
  optimisticUpdate?:
    | ((localQueryStore: OptimisticLocalStore, args: Args) => void)
    | undefined;
};

/**
 * Options for {@link withConvexAction}: the options of `withAsync`.
 *
 * @public
 */
export type ConvexActionOptions<
  Err = Error,
  EmptyErr = undefined,
> = AsyncOptions<Err, EmptyErr>;

/** Calls `run` with what the action's callback returned, awaited if needed. */
const callWith =
  (run: (args: any) => Promise<unknown>) =>
  (next: (...params: any[]) => unknown, ...params: any[]) => {
    const args = next(...params);
    if (!(args instanceof Promise)) return run(args);
    return (async () => run(await wrap(args)))();
  };

/**
 * Turns an action that returns the arguments of `mutation` into one that runs
 * the mutation with them and returns its promise. A failed mutation rejects
 * with a `ConvexError` when the function threw one. Adds `withAsync`'s
 * `ready`, `pending`, `error` and the rest.
 *
 * ```ts
 * const addNote = action((text: string) => ({ text }), "addNote").extend(
 *   withConvexMutation(convex, api.notes.add),
 * );
 *
 * await wrap(addNote("Hello"));
 * addNote.ready(); // false while a call is pending
 * ```
 *
 * The callback may return a promise of the arguments, and nothing for a
 * mutation whose arguments are all optional.
 *
 * @param client - The client, or a function that returns it.
 * @param mutation - A mutation reference, or a function path.
 *
 * @public
 */
export function withConvexMutation<
  Mutation extends MutationRef,
  Err = Error,
  EmptyErr = undefined,
>(
  client: ConvexClientSource,
  mutation: Mutation,
  options: ConvexMutationOptions<ArgsOf<Mutation>, Err, EmptyErr> = {},
): <Target extends Action<any[], ConvexCallArgs<ArgsOf<Mutation>>>>(
  target: Target,
) => ConvexCallAction<Target, ReturnOf<Mutation>, Err | EmptyErr> {
  const { optimisticUpdate, ...asyncOptions } = options;
  const mutationOptions = { optimisticUpdate };
  return (target) =>
    (target as Action).extend(
      withActionMiddleware(() =>
        callWith((args) =>
          clientOf(client).mutation(mutation, args, mutationOptions),
        ),
      ),
      withAsync(asyncOptions),
    ) as any;
}

/**
 * Turns an action that returns the arguments of `convexAction` into one that
 * runs the Convex action with them and returns its promise. A failed action
 * rejects with a `ConvexError` when the function threw one. Adds
 * `withAsync`'s `ready`, `pending`, `error` and the rest.
 *
 * ```ts
 * const send = action((to: string) => ({ to }), "send").extend(
 *   withConvexAction(convex, api.mail.send),
 * );
 * ```
 *
 * The callback may return a promise of the arguments, and nothing for an
 * action whose arguments are all optional.
 *
 * @param client - The client, or a function that returns it.
 * @param convexAction - An action reference, or a function path.
 *
 * @public
 */
export function withConvexAction<
  ConvexAction extends ActionRef,
  Err = Error,
  EmptyErr = undefined,
>(
  client: ConvexClientSource,
  convexAction: ConvexAction,
  options: ConvexActionOptions<Err, EmptyErr> = {},
): <Target extends Action<any[], ConvexCallArgs<ArgsOf<ConvexAction>>>>(
  target: Target,
) => ConvexCallAction<Target, ReturnOf<ConvexAction>, Err | EmptyErr> {
  return (target) =>
    (target as Action).extend(
      withActionMiddleware(() =>
        callWith((args) => clientOf(client).action(convexAction, args)),
      ),
      withAsync(options),
    ) as any;
}
