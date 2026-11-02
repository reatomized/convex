/**
 * A client whose functions are handlers a test registers, for UI tests and
 * stories without a deployment. Query handlers run inside computeds, so a
 * handler that reads atoms re-runs when they change, and a mutation handler
 * that writes them updates every query that reads them.
 *
 * Handlers and state are per Reatom context, like the real client's.
 */
import {
  action,
  atom,
  computed,
  context,
  peek,
  wrap,
  type Atom,
} from "@reatom/core";
import {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  getFunctionName,
  PaginationOptions,
  PaginationResult,
  UserIdentity,
} from "convex/server";
import { ConvexError, convexToJson, jsonToConvex, Value } from "convex/values";
import { parseArgs } from "../../common/index.js";
import { jwtDecode } from "../../vendor/jwt-decode/index.js";
import { FunctionResult } from "../sync/function_result.js";
import {
  canonicalizeUdfPath,
  QueryToken,
  serializePaginatedPathAndArgs,
} from "../sync/udf_path_utils.js";
import type { AuthTokenFetcher } from "./auth.js";
import type {
  ConnectionState,
  QueryStatus,
  ReatomConvexClient,
  ReatomQuery,
} from "./client.js";
import { identityFromToken } from "./fake_auth.js";
import { reatomPaginatedQuery, ReatomPaginatedQuery } from "./paginated.js";
import type { SocketState } from "./socket.js";

/**
 * Return it from a query handler to keep the query loading.
 *
 * @public
 */
export const loading: unique symbol = Symbol("loading");

/**
 * What a handler knows besides its arguments, like a function's `ctx.auth`.
 *
 * @public
 */
export type FunctionContext = {
  /**
   * The identity of the token the client authenticated with, or the one set on
   * `identity`; `null` without one.
   */
  readonly identity: UserIdentity | null;
};

/** @public */
export type QueryHandler<Query extends FunctionReference<"query">> = (
  args: FunctionArgs<Query>,
  ctx: FunctionContext,
) => FunctionReturnType<Query> | typeof loading;

/** @public */
export type MutationHandler<Mutation extends FunctionReference<"mutation">> = (
  args: FunctionArgs<Mutation>,
  ctx: FunctionContext,
) => FunctionReturnType<Mutation> | Promise<FunctionReturnType<Mutation>>;

/** @public */
export type ActionHandler<Action extends FunctionReference<"action">> = (
  args: FunctionArgs<Action>,
  ctx: FunctionContext,
) => FunctionReturnType<Action> | Promise<FunctionReturnType<Action>>;

type FunctionType = "query" | "mutation" | "action";
type AnyHandler = (args: any, ctx: FunctionContext) => unknown;
type Handlers = { readonly [Type in FunctionType]: Map<string, AnyHandler> };

const capitalized = { query: "Query", mutation: "Mutation", action: "Action" };

/**
 * A function called on a fake client without a handler. Reading such a query
 * throws it; calling such a mutation or action throws it before returning a
 * promise. The fake also logs it with `console.error` and lists it in
 * `unhandled`, since app code may catch the throw.
 *
 * @public
 */
export class MissingHandlerError extends Error {
  readonly type: FunctionType;
  readonly udfPath: string;

  constructor(type: FunctionType, udfPath: string) {
    const [module, name] = udfPath.split(":");
    const reference = ["api", ...module.split("/"), name].join(".");
    super(
      `No fake handler for ${type} ${udfPath}. Register one with handle${capitalized[type]}(${reference}, ...).`,
    );
    this.name = "MissingHandlerError";
    this.type = type;
    this.udfPath = udfPath;
  }
}

/**
 * A page of `items` for a paginated query handler. Cursors are offsets into
 * `items`, so an item inserted before a loaded page shifts the pages after it.
 *
 * @public
 */
export function paginate<T>(
  items: readonly T[],
  { cursor, numItems, endCursor }: PaginationOptions,
): PaginationResult<T> {
  const start = cursor === null ? 0 : Number(cursor);
  const end = Math.min(
    endCursor === undefined || endCursor === null
      ? start + numItems
      : Number(endCursor),
    items.length,
  );
  return {
    page: items.slice(start, end),
    isDone: end >= items.length,
    continueCursor: String(end),
  };
}

/**
 * A {@link ReatomConvexClient} that runs registered handlers instead of
 * talking to a deployment.
 *
 * @public
 */
export interface ReatomConvexClientFake extends ReatomConvexClient {
  /** Set by `setAuth` and `clearAuth`; settable to skip the token flow. */
  readonly isAuthenticated: Atom<boolean | null>;
  readonly isRefreshingAuth: Atom<boolean>;
  /**
   * The identity handlers see. `setAuth` sets it from the token's claims and
   * `clearAuth` resets it.
   */
  readonly identity: Atom<UserIdentity | null>;
  readonly socketState: Atom<SocketState>;
  /**
   * Whether `connectionState` reports an open socket, `true` by default.
   * Requests still run while it is `false`.
   */
  readonly connected: Atom<boolean>;
  /** Functions called without a handler, once each. */
  readonly unhandled: readonly MissingHandlerError[];
  /**
   * Answer `query` with `handler`, replacing an earlier one. Queries using it
   * run it again. Call it inside a Reatom frame.
   */
  handleQuery<Query extends FunctionReference<"query">>(
    query: Query,
    handler: QueryHandler<Query>,
  ): void;
  handleMutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    handler: MutationHandler<Mutation>,
  ): void;
  handleAction<Action extends FunctionReference<"action">>(
    action: Action,
    handler: ActionHandler<Action>,
  ): void;
}

type Outcome =
  | { status: "loading" }
  | { status: "success"; value: Value }
  | { status: "error"; error: Error };

const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const functionName = (ref: { toString(): string } | string): string =>
  canonicalizeUdfPath(
    typeof ref === "string" ? ref : getFunctionName(ref as any),
  );

/**
 * Create a fake client. Register handlers inside the frame that uses it:
 *
 * ```ts
 * const convex = reatomConvexClientFake();
 * const notes = atom<string[]>([], "notes");
 * convex.handleQuery(api.notes.list, () => notes());
 * convex.handleMutation(api.notes.add, ({ text }) => {
 *   notes.set((all) => [...all, text]);
 *   return null;
 * });
 * ```
 *
 * @param name - A prefix for the client's atom names.
 *
 * @public
 */
export function reatomConvexClientFake(
  name = "convex",
): ReatomConvexClientFake {
  const handlers = atom(
    (): Handlers => ({
      query: new Map(),
      mutation: new Map(),
      action: new Map(),
    }),
    `${name}._handlers`,
  );
  const identity = atom<UserIdentity | null>(null, `${name}.identity`);
  const isAuthenticated = atom<boolean | null>(
    false,
    `${name}.isAuthenticated`,
  );
  const isRefreshingAuth = atom(false, `${name}.isRefreshingAuth`);
  const authToken = atom<string | undefined>(undefined, `${name}.authToken`);
  /** Bumped by each `setAuth` and `clearAuth`, so a stale token is dropped. */
  const authVersion = atom(0, `${name}._authVersion`);
  const connected = atom(true, `${name}.connected`);
  const inflight = atom<
    ReadonlyArray<{ type: "mutation" | "action"; at: Date }>
  >([], `${name}._inflight`);

  const unhandled: MissingHandlerError[] = [];
  const miss = (type: FunctionType, udfPath: string) => {
    const error = new MissingHandlerError(type, udfPath);
    if (!unhandled.some((seen) => seen.message === error.message)) {
      unhandled.push(error);
      // A second channel: app code may catch the throw and show it as a
      // server failure.
      // eslint-disable-next-line no-console
      console.error(error.message);
    }
    return error;
  };

  const register = (type: FunctionType, ref: unknown, handler: AnyHandler) => {
    const udfPath = functionName(ref as FunctionReference<FunctionType>);
    handlers.set((current) => ({
      ...current,
      [type]: new Map(current[type]).set(udfPath, handler),
    }));
  };

  const functionContext = (): FunctionContext => ({ identity: identity() });

  /** A handler's result as the client would receive it from the server. */
  const received = (type: FunctionType, udfPath: string, returned: unknown) => {
    try {
      return jsonToConvex(
        convexToJson((returned === undefined ? null : returned) as Value),
      );
    } catch (error) {
      throw new Error(
        `The fake ${type} handler for ${udfPath} returned a value Convex can't send: ${asError(error).message}`,
      );
    }
  };

  let nextTraceId = 0;
  const entries = new Map<string, ReatomQuery>();
  const queryEntry = (
    udfPath: string,
    args: Record<string, Value>,
  ): ReatomQuery => {
    const token = JSON.stringify({
      udfPath,
      args: convexToJson(args),
    }) as QueryToken;
    const existing = entries.get(token);
    if (existing !== undefined) return existing;
    const trace = `${name}.query#${udfPath}#${nextTraceId++}`;
    const outcome = computed((): Outcome => {
      const handler = handlers().query.get(udfPath);
      if (handler === undefined) throw miss("query", udfPath);
      let returned: unknown;
      try {
        returned = handler(args, functionContext());
      } catch (error) {
        return { status: "error", error: asError(error) };
      }
      if (returned === loading) return { status: "loading" };
      if (returned instanceof Promise) {
        throw new Error(
          `The fake query handler for ${udfPath} returned a Promise. Query handlers are synchronous: return \`loading\` until an atom the handler reads changes.`,
        );
      }
      return {
        status: "success",
        value: received("query", udfPath, returned),
      };
    }, `${trace}.outcome`);
    const entry: ReatomQuery = {
      token,
      udfPath,
      args,
      result: computed((): FunctionResult | undefined => {
        const current = outcome();
        if (current.status === "loading") return undefined;
        if (current.status === "success") {
          return { success: true, value: current.value, logLines: [] };
        }
        const { error } = current;
        return {
          success: false,
          errorMessage: error.message,
          ...(error instanceof ConvexError
            ? { errorData: error.data as Value }
            : {}),
          logLines: [],
        };
      }, trace),
      data: computed(() => {
        const current = outcome();
        return current.status === "success" ? current.value : undefined;
      }, `${trace}.data`),
      error: computed(() => {
        const current = outcome();
        return current.status === "error" ? current.error : undefined;
      }, `${trace}.error`),
      status: computed((): QueryStatus => outcome().status, `${trace}.status`),
    };
    entries.set(token, entry);
    return entry;
  };

  const paginated = new Map<string, ReatomPaginatedQuery>();
  const paginatedQueryEntry = (
    udfPath: string,
    args: Record<string, Value>,
    options: { initialNumItems: number; id: number },
  ) => {
    const token = serializePaginatedPathAndArgs(udfPath, args, options);
    const existing = paginated.get(token);
    if (existing !== undefined) return existing;
    const created = reatomPaginatedQuery(
      (pageUdfPath, pageArgs, paginationOpts) =>
        queryEntry(pageUdfPath, { ...pageArgs, paginationOpts }),
      udfPath,
      args,
      options,
      `${name}.paginatedQuery#${udfPath}#${nextTraceId++}`,
    );
    paginated.set(token, created);
    return created;
  };

  const request = (type: "mutation" | "action") =>
    action(
      async (
        udfPath: string,
        handler: AnyHandler,
        args: Record<string, Value>,
      ): Promise<any> => {
        const call = { type, at: new Date() };
        inflight.set((all) => [...all, call]);
        try {
          // The server gets its own copy of the arguments.
          const serverArgs = jsonToConvex(convexToJson(args));
          const returned = handler(serverArgs, functionContext());
          return received(type, udfPath, await wrap(Promise.resolve(returned)));
        } finally {
          inflight.set((all) => all.filter((current) => current !== call));
        }
      },
      `${name}.${type}`,
    );
  const requests = { mutation: request("mutation"), action: request("action") };

  const call = (
    type: "mutation" | "action",
    ref: unknown,
    args: Record<string, Value> | undefined,
  ) => {
    const udfPath = functionName(ref as string);
    const handler = peek(handlers)[type].get(udfPath);
    if (handler === undefined) throw miss(type, udfPath);
    return requests[type](udfPath, handler, parseArgs(args));
  };

  const setAuth = action(
    (
      fetchToken: AuthTokenFetcher,
      onChange?: (isAuthenticated: boolean) => void,
      _onRefreshChange?: (isRefreshing: boolean) => void,
    ) => {
      const version = authVersion.set((current) => current + 1);
      isAuthenticated.set(null);
      isRefreshingAuth.set(false);
      // The fetch outlives the caller's frame, like the real client's flow.
      const accept = async () => {
        let token: string | null | undefined;
        try {
          token = await wrap(fetchToken({ forceRefreshToken: false }));
        } catch {
          token = null;
        }
        if (authVersion() !== version) return;
        authToken.set(token ?? undefined);
        identity.set(token ? identityFromToken(token) : null);
        isAuthenticated.set(!!token);
        onChange?.(!!token);
      };
      void wrap(accept, context())();
    },
    `${name}.setAuth`,
  );

  const clearAuth = action(() => {
    authVersion.set((current) => current + 1);
    authToken.set(undefined);
    identity.set(null);
    isAuthenticated.set(false);
    isRefreshingAuth.set(false);
  }, `${name}.clearAuth`);

  const fake: ReatomConvexClientFake = {
    name,
    url: `fake:${name}`,
    connectionState: computed((): ConnectionState => {
      const calls = inflight();
      return {
        hasInflightRequests: calls.length > 0,
        isWebSocketConnected: connected(),
        timeOfOldestInflightRequest: calls[0]?.at ?? null,
        hasEverConnected: true,
        connectionCount: 1,
        connectionRetries: 0,
        inflightMutations: calls.filter(({ type }) => type === "mutation")
          .length,
        inflightActions: calls.filter(({ type }) => type === "action").length,
      };
    }, `${name}.connectionState`),
    isAuthenticated,
    isRefreshingAuth,
    authClaims: computed(() => {
      const token = authToken();
      if (token === undefined) return undefined;
      let decoded: Record<string, any>;
      try {
        decoded = jwtDecode(token);
      } catch {
        decoded = {};
      }
      return { token, decoded };
    }, `${name}.authClaims`),
    socketState: atom<SocketState>(
      { state: "ready", paused: "no" },
      `${name}.socketState`,
    ),
    identity,
    connected,
    get unhandled() {
      return unhandled;
    },
    query: (query, args) =>
      queryEntry(
        functionName(query),
        parseArgs(args as Record<string, Value> | undefined),
      ) as ReatomQuery<any>,
    paginatedQuery: (query, args, options) =>
      paginatedQueryEntry(
        functionName(query),
        parseArgs(args as Record<string, Value>),
        { initialNumItems: options.initialNumItems, id: options.id ?? -1 },
      ) as ReatomPaginatedQuery<any>,
    mutation: (mutation, args) =>
      call("mutation", mutation, args as Record<string, Value> | undefined),
    action: (action, args) =>
      call("action", action, args as Record<string, Value> | undefined),
    setAuth,
    clearAuth,
    close: action(() => Promise.resolve(), `${name}.close`),
    handleQuery: (query, handler) => register("query", query, handler),
    handleMutation: (mutation, handler) =>
      register("mutation", mutation, handler),
    handleAction: (action, handler) => register("action", action, handler),
  };
  return fake;
}
