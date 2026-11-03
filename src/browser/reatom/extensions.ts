/**
 * Reatom extensions that bind atoms and actions to Convex functions.
 *
 * `withConvexQuery` and `withConvexPaginatedQuery` go on an atom whose state is
 * the query's arguments, or `"skip"`, and add the query's state to it.
 * `withConvexMutation`, `withConvexAction` and `withConvexQuery` go on an action
 * that returns the function's arguments; the action then calls the function,
 * or reads the query once, and returns its promise, with `withAsync`'s state.
 * `updateQuery` turns a query atom into an optimistic update for a mutation.
 *
 * Each extension takes the client, or a function that returns it, which it
 * calls when it needs the client: inside the computeds for queries, and on each
 * call for mutations and actions.
 */
import {
  action,
  computed,
  isAction,
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
import {
  makeFunctionReference,
  type FunctionReference,
  type PaginationResult,
} from "convex/server";
import { convexToJson, type Value } from "convex/values";
import type { FunctionResult } from "../sync/function_result.js";
import type { PaginationStatus } from "../sync/pagination.js";
import { functionError } from "./errors.js";
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

/** The query behind an atom extended with a query extension. */
type QueryAtom = {
  kind: "query" | "paginated";
  reference: FunctionReference<"query">;
};

const QUERY_ATOMS = new WeakMap<object, QueryAtom>();

const referenceOf = (query: QueryRef): FunctionReference<"query"> =>
  typeof query === "string"
    ? makeFunctionReference<"query">(query)
    : (query as FunctionReference<"query">);

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
 * Options for {@link withConvexQuery}: the query's journal and, for an action,
 * the options of `withAsync`.
 *
 * @public
 */
export type ConvexQueryOptions = ReatomQueryOptions &
  AsyncOptions & {
    /**
     * While the query for new arguments loads, `data` keeps the value of the
     * previous ones instead of `undefined`, as Convex's `useStableQuery`
     * recipe does. `status` still reports `loading`.
     */
    keepPreviousData?: boolean;
  };

/** What {@link withConvexQuery} makes of `Target`. */
type ConvexQueryExtension<Target, Query> = [Target] extends [
  Action<any[], infer Payload>,
]
  ? [Payload] extends [ConvexCallArgs<ArgsOf<Query>>]
    ? ConvexCallAction<Target, ReturnOf<Query>, Error>
    : {
        withConvexQuery_ERROR: "The action should return the query's arguments";
      }
  : [AtomState<Target>] extends [ArgsOf<Query> | "skip"]
    ? ConvexQueryExt<ReturnOf<Query>>
    : {
        withConvexQuery_ERROR: "The atom's state should be the query's arguments or \"skip\"";
      };

/** Resolves with the entry's first result, keeping it subscribed until then. */
const firstResult = (entry: ReatomQuery): Promise<Value> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    unsubscribe = entry.result.subscribe(
      (result: FunctionResult | undefined) => {
        if (result === undefined || settled) return;
        settled = true;
        unsubscribe?.();
        if (result.success) resolve(result.value);
        else reject(functionError("query", entry.udfPath, result));
      },
    );
    // A result already held settles during `subscribe`.
    if (settled) unsubscribe();
  });

/**
 * On an atom, subscribes the atom's state, the arguments of `query`, while one
 * of the atoms this adds is read in a subscribed graph. When the arguments
 * change, the query for the new ones replaces the old one in the same query
 * set change. `"skip"` subscribes nothing.
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
 * On an action that returns the query's arguments, reads the query once, as
 * `ConvexClient.query` does: the action subscribes it until the first result
 * and returns a promise of it, with `withAsync`'s state. A query another
 * reader holds resolves with its current result.
 *
 * ```ts
 * const loadNote = action((id: Id<"notes">) => ({ id }), "loadNote").extend(
 *   withConvexQuery(convex, api.notes.get),
 * );
 *
 * const note = await wrap(loadNote(id));
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
  options: ConvexQueryOptions = {},
): <Target extends AtomLike>(
  target: Target,
) => ConvexQueryExtension<Target, Query> {
  type T = ReturnOf<Query>;
  return ((target: AtomLike) => {
    if (isAction(target)) {
      return target.extend(
        withActionMiddleware(() =>
          callWith((args) =>
            firstResult(clientOf(client).query(query, args, options)),
          ),
        ),
        withAsync(options),
      );
    }
    QUERY_ATOMS.set(target, { kind: "query", reference: referenceOf(query) });
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
      // A computed that takes its previous state costs more to build, so only
      // `keepPreviousData` gets one.
      data: () =>
        options.keepPreviousData
          ? computed<T | undefined>((previous) => {
              const current = entryOf()();
              const result = current?.result();
              if (result === undefined && current) return previous;
              return result?.success ? (result.value as T) : undefined;
            }, `${target.name}.data`)
          : computed((): T | undefined => {
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
  /**
   * While the first page for new arguments loads, `results` keeps the items
   * of the previous ones instead of an empty list. `status` still reports
   * `LoadingFirstPage`.
   */
  keepPreviousData?: boolean;
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
    QUERY_ATOMS.set(target, {
      kind: "paginated",
      reference: referenceOf(query),
    });
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
        options.keepPreviousData
          ? computed<Item[]>((previous) => {
              const current = paginated()();
              if (current === undefined) return NO_RESULTS;
              if (
                previous !== undefined &&
                current.status() === "LoadingFirstPage"
              ) {
                return previous;
              }
              return current.results();
            }, `${target.name}.results`)
          : computed(
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
 * Where a page sits in its paginated query, for {@link updateQuery}.
 *
 * @public
 */
export type ConvexPagePosition = {
  /** The page that starts the list, where `insertAtTop` puts an item. */
  first: boolean;
  /** The page that ends an exhausted list. */
  last: boolean;
};

/**
 * An optimistic update of one query atom, made by {@link updateQuery}.
 *
 * @public
 */
export interface ConvexOptimisticUpdate<Args> {
  /**
   * The update for the atom's current arguments, `undefined` while it holds
   * `"skip"`. `withConvexMutation` calls it when the mutation is called, so
   * the update keeps those arguments while the mutation is pending.
   */
  readonly bind: () =>
    | ((localQueryStore: OptimisticLocalStore, args: Args) => void)
    | undefined;
}

/**
 * What `withConvexMutation` takes as `optimisticUpdate`: an update of the local
 * store, query atom updates from {@link updateQuery}, or a list of both.
 *
 * @public
 */
export type ConvexOptimisticUpdates<Args> =
  | ((localQueryStore: OptimisticLocalStore, args: Args) => void)
  | ConvexOptimisticUpdate<Args>
  | ReadonlyArray<
      | ((localQueryStore: OptimisticLocalStore, args: Args) => void)
      | ConvexOptimisticUpdate<Args>
    >;

type StoreUpdate = (localQueryStore: OptimisticLocalStore, args: any) => void;

const valueUpdate =
  (
    reference: FunctionReference<"query">,
    args: Record<string, Value>,
    update: (current: any, args: any, store: OptimisticLocalStore) => any,
  ): StoreUpdate =>
  (store, mutationArgs) => {
    const current = store.getQuery(reference, args);
    if (current === undefined) return;
    const next = update(current, mutationArgs, store);
    if (next !== current) store.setQuery(reference, args, next);
  };

const pagesUpdate = (
  reference: FunctionReference<"query">,
  args: Record<string, Value>,
  update: (
    page: any[],
    args: any,
    position: ConvexPagePosition,
    store: OptimisticLocalStore,
  ) => any[],
): StoreUpdate => {
  const key = JSON.stringify(convexToJson(args));
  return (store, mutationArgs) => {
    // Every page list of these arguments, whatever its `id`, as convex/react's
    // pagination helpers do.
    for (const { args: pageArgs, value } of store.getAllQueries(reference)) {
      if (value === undefined) continue;
      const { paginationOpts, ...rest } = pageArgs as {
        paginationOpts: { cursor: string | null };
      };
      if (JSON.stringify(convexToJson(rest as Value)) !== key) continue;
      const result = value as PaginationResult<Value>;
      const position = {
        first: paginationOpts.cursor === null,
        last: result.isDone,
      };
      const page = update(result.page, mutationArgs, position, store);
      if (page !== result.page) {
        store.setQuery(reference, pageArgs, { ...result, page });
      }
    }
  };
};

/**
 * An optimistic update of a query atom for `withConvexMutation`. `update` gets
 * the query's local value and the mutation's arguments and returns the new
 * value; it runs only while the query has a value. For an atom extended with
 * {@link withConvexPaginatedQuery}, it runs for each loaded page and returns
 * that page's items.
 *
 * ```ts
 * const addNote = action((text: string) => ({ text }), "addNote").extend(
 *   withConvexMutation(convex, api.notes.add, {
 *     optimisticUpdate: [
 *       updateQuery(count, (n) => n + 1),
 *       updateQuery(notes, (page, { text }, { first }) =>
 *         first ? [{ _id: "optimistic", text }, ...page] : page,
 *       ),
 *     ],
 *   }),
 * );
 * ```
 *
 * The update applies to the arguments the atom holds when the mutation is
 * called. The last parameter is the local store, for values of other queries.
 *
 * @public
 */
export function updateQuery<T, Args>(
  query: ConvexQueryExt<T>,
  update: (current: T, args: Args, localQueryStore: OptimisticLocalStore) => T,
): ConvexOptimisticUpdate<Args>;
export function updateQuery<Item, Args>(
  query: ConvexPaginatedQueryExt<Item>,
  update: (
    page: Item[],
    args: Args,
    position: ConvexPagePosition,
    localQueryStore: OptimisticLocalStore,
  ) => Item[],
): ConvexOptimisticUpdate<Args>;
export function updateQuery(
  query: object,
  update: (...params: any[]) => any,
): ConvexOptimisticUpdate<unknown> {
  const found = QUERY_ATOMS.get(query);
  if (!found) {
    throw new Error(
      "updateQuery takes an atom extended with withConvexQuery or withConvexPaginatedQuery",
    );
  }
  const target = query as AtomLike;
  return {
    bind: () => {
      const args = target();
      if (args === "skip") return undefined;
      return found.kind === "query"
        ? valueUpdate(found.reference, args, update)
        : pagesUpdate(found.reference, args, update);
    },
  };
}

/** The optimistic update of one call, with query atoms bound to their arguments. */
const optimisticFor = (
  updates: ConvexOptimisticUpdates<any> | undefined,
): StoreUpdate | undefined => {
  if (updates === undefined) return undefined;
  const list: ReadonlyArray<StoreUpdate | ConvexOptimisticUpdate<any>> =
    Array.isArray(updates) ? updates : [updates as StoreUpdate];
  const bound: StoreUpdate[] = [];
  for (const update of list) {
    const fn = typeof update === "function" ? update : update.bind();
    if (fn) bound.push(fn);
  }
  if (bound.length <= 1) return bound[0];
  return (store, args) => {
    for (const fn of bound) fn(store, args);
  };
};

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
  optimisticUpdate?: ConvexOptimisticUpdates<Args> | undefined;
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
  return (target) =>
    (target as Action).extend(
      withActionMiddleware(() =>
        callWith((args) =>
          clientOf(client).mutation(mutation, args, {
            optimisticUpdate: optimisticFor(optimisticUpdate),
          }),
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
