import {
  action,
  atom,
  computed,
  context,
  noop,
  withActions,
  wrap,
  type Action,
  type Atom,
  type Computed,
} from "@reatom/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vitest";
import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { ConvexError } from "convex/values";
import { reatomConvexClient, type ReatomQuery } from "./client.js";
import {
  withConvexAction,
  withConvexMutation,
  withConvexPaginatedQuery,
  withConvexQuery,
  type ConvexQueryStatus,
} from "./extensions.js";
import { clientOptions, FakeServer, settle } from "./parity_test_helpers.js";
import { loading, paginate, reatomConvexClientFake } from "./testing.js";

const URL = "https://happy-otter-123.convex.cloud";
const list = makeFunctionReference<"query", { tag?: string }, string[]>(
  "notes:list",
);
const get = makeFunctionReference<"query", { id: number }, string>("notes:get");
const add = makeFunctionReference<"mutation", { text: string }, string>(
  "notes:add",
);
const clear = makeFunctionReference<"mutation", Record<string, never>, null>(
  "notes:clear",
);
const send = makeFunctionReference<"action", { to: string }, string>(
  "mail:send",
);
const page = makeFunctionReference<
  "query",
  { tag: string; paginationOpts: PaginationOptions },
  PaginationResult<number>
>("notes:page");

let trace: unknown[];
let server: FakeServer;

beforeEach(() => {
  trace = [];
  server = new FakeServer(trace);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mutations and actions the server received. */
const requests = () =>
  trace
    .filter((entry: any) => ["Mutation", "Action"].includes(entry.received))
    .map(({ received, udfPath, args }: any) => ({
      type: received,
      udfPath,
      args,
    }));

describe("withConvexQuery", () => {
  test("subscribes the atom's arguments and swaps them in one message", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const id = atom<number | null>(1, "id");
    const note = computed(() => {
      const current = id();
      return current === null ? "skip" : { id: current };
    }, "note").extend(withConvexQuery(convex, get));

    const seen: unknown[] = [];
    const unsubscribe = frame.run(() =>
      note.data.subscribe((value) => seen.push(value)),
    );
    await settle();
    server.open();
    expect(server.querySet()).toEqual([
      JSON.stringify({ udfPath: "notes:get", args: { id: 1 } }),
    ]);
    frame.run(() => {
      expect(note.status()).toBe("loading");
      expect(note.ready()).toBe(false);
    });

    server.transition([["notes:get", { id: 1 }, { value: "one" }]]);
    await settle();
    frame.run(() => {
      expect(note.data()).toBe("one");
      expect(note.status()).toBe("success");
      expect(note.ready()).toBe(true);
      expect(note.query()).toBe(convex.query(get, { id: 1 }));
    });

    const sent = vi.spyOn(server.socket, "send");
    frame.run(() => id.set(2));
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sent.mock.calls[0][0]).modifications).toMatchObject([
      { type: "Add", args: [{ id: 2 }] },
      { type: "Remove" },
    ]);
    server.transition([["notes:get", { id: 2 }, { value: "two" }]]);
    await settle();

    frame.run(() => id.set(null));
    await settle();
    expect(server.querySet()).toEqual([]);
    frame.run(() => {
      expect(note.status()).toBe("skipped");
      expect(note.ready()).toBe(true);
      expect(note.query()).toBeUndefined();
      expect(note.data()).toBeUndefined();
    });
    expect(seen).toEqual([undefined, "one", undefined, "two", undefined]);

    unsubscribe();
    await frame.run(() => convex.close());
  });

  test("keeps a ConvexError a query failed with", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const notes = atom({ tag: "x" }, "notes").extend(
      withConvexQuery(convex, list),
    );
    frame.run(() => notes.error.subscribe(noop));
    await settle();
    server.open();
    server.transition([
      ["notes:list", { tag: "x" }, { error: "nope", errorData: { code: 1 } }],
    ]);
    frame.run(() => {
      expect(notes.status()).toBe("error");
      expect(notes.ready()).toBe(true);
      expect(notes.error()).toBeInstanceOf(ConvexError);
      expect((notes.error() as ConvexError<any>).data).toEqual({ code: 1 });
      expect(notes.data()).toBeUndefined();
    });
    await frame.run(() => convex.close());
  });

  test("reads the client from a function, so the client can change", () => {
    const frame = context.start();
    const first = reatomConvexClientFake();
    const second = reatomConvexClientFake();
    const client = atom(first, "client");
    frame.run(() => {
      first.handleQuery(list, () => ["first"]);
      second.handleQuery(list, () => ["second"]);
    });
    const notes = atom({}, "notes").extend(withConvexQuery(client, list));
    frame.run(() => {
      notes.data.subscribe(noop);
      expect(notes.data()).toEqual(["first"]);
      client.set(second);
      expect(notes.data()).toEqual(["second"]);
    });
  });

  test("follows a fake's handlers", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const ready = atom(false, "ready");
    frame.run(() =>
      convex.handleQuery(get, ({ id }) => (ready() ? `note ${id}` : loading)),
    );
    const note = atom({ id: 1 }, "note").extend(withConvexQuery(convex, get));
    frame.run(() => {
      note.data.subscribe(noop);
      expect(note.status()).toBe("loading");
      ready.set(true);
      expect(note.data()).toBe("note 1");
      note.set({ id: 2 });
      expect(note.data()).toBe("note 2");
    });
  });

  test("types the state, the arguments and the result", () => {
    const convex = reatomConvexClientFake();
    const note = atom({ id: 1 }, "note").extend(withConvexQuery(convex, get));
    expectTypeOf(note.data).toEqualTypeOf<Computed<string | undefined>>();
    expectTypeOf(note.status).toEqualTypeOf<Computed<ConvexQueryStatus>>();
    expectTypeOf(note.query).toEqualTypeOf<
      Computed<ReatomQuery<string> | undefined>
    >();
    // The atom keeps its own API.
    expectTypeOf(note).toMatchTypeOf<Atom<{ id: number }>>();
    expectTypeOf(
      computed(() => "skip" as const, "skipped").extend(
        withConvexQuery(convex, get),
      ).data,
    ).toEqualTypeOf<Computed<string | undefined>>();

    // Like Reatom's own extensions, a mismatch shows in the extended type.
    expectTypeOf(
      atom({}, "noId").extend(withConvexQuery(convex, get)),
    ).toHaveProperty("withConvexQuery_ERROR");
    expectTypeOf(
      atom({ id: "1" }, "wrongId").extend(withConvexQuery(convex, get)),
    ).toHaveProperty("withConvexQuery_ERROR");
  });
});

describe("withConvexPaginatedQuery", () => {
  test("pages through the atom's arguments and skips", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    frame.run(() =>
      convex.handleQuery(page, ({ tag, paginationOpts }) =>
        paginate(
          [1, 2, 3, 4, 5].filter((item) => tag === "all" || item % 2 === 1),
          paginationOpts,
        ),
      ),
    );
    const tag = atom<string | null>("all", "tag");
    const notes = computed(() => {
      const current = tag();
      return current === null ? "skip" : { tag: current };
    }, "notes").extend(
      withConvexPaginatedQuery(convex, page, { initialNumItems: 2 }),
    );
    frame.run(() => {
      notes.results.subscribe(noop);
      expect(notes.results()).toEqual([1, 2]);
      expect(notes.status()).toBe("CanLoadMore");
      expect(notes.loadMore(2)).toBe(true);
      expect(notes.results()).toEqual([1, 2, 3, 4]);

      tag.set("odd");
      expect(notes.results()).toEqual([1, 3]);
      expect(notes.loadMore(5)).toBe(true);
      expect(notes.results()).toEqual([1, 3, 5]);
      expect(notes.status()).toBe("Exhausted");

      tag.set(null);
      expect(notes.status()).toBe("Skipped");
      expect(notes.results()).toEqual([]);
      expect(notes.query()).toBeUndefined();
      expect(notes.loadMore(2)).toBe(false);
    });
  });

  test("types the items and the arguments without paginationOpts", () => {
    const convex = reatomConvexClientFake();
    const notes = atom({ tag: "a" }, "notes").extend(
      withConvexPaginatedQuery(convex, page, { initialNumItems: 1 }),
    );
    expectTypeOf(notes.results).toEqualTypeOf<Computed<number[]>>();
    expectTypeOf(notes.loadMore).toEqualTypeOf<
      Action<[numItems: number], boolean>
    >();
    expectTypeOf(
      atom({}, "noTag").extend(
        withConvexPaginatedQuery(convex, page, { initialNumItems: 1 }),
      ),
    ).toHaveProperty("withConvexPaginatedQuery_ERROR");
  });
});

describe("withConvexMutation", () => {
  test("runs the mutation with the arguments the action returns", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const notes = atom({}, "notes").extend(withConvexQuery(convex, list));
    const addNote = action(
      (text: string) => ({ text: text.trim() }),
      "addNote",
    ).extend(
      withConvexMutation(convex, add, {
        optimisticUpdate: (store, { text }) => {
          const current = store.getQuery(list, {});
          if (current) store.setQuery(list, {}, [...current, text]);
        },
      }),
    );
    frame.run(() => notes.data.subscribe(noop));
    await settle();
    server.open();
    server.transition([["notes:list", {}, { value: ["a"] }]]);

    const result = frame.run(() => addNote("  b "));
    frame.run(() => {
      expect(notes.data()).toEqual(["a", "b"]);
      expect(addNote.ready()).toBe(false);
      expect(addNote.pending()).toBe(1);
    });
    await settle();
    expect(requests()).toMatchObject([
      { type: "Mutation", udfPath: "notes:add", args: [{ text: "b" }] },
    ]);
    server.respond(0, { value: "id-b" });
    server.transition([["notes:list", {}, { value: ["a", "b"] }]]);
    await expect(result).resolves.toBe("id-b");
    frame.run(() => {
      expect(addNote.ready()).toBe(true);
      expect(addNote.error()).toBeUndefined();
      expect(notes.data()).toEqual(["a", "b"]);
    });
    await frame.run(() => convex.close());
  });

  test("a failed mutation rejects and lands in `error`", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const addNote = action((text: string) => ({ text }), "addNote").extend(
      withConvexMutation(convex, add),
    );
    const result = frame.run(() => addNote("b"));
    await settle();
    server.open();
    await settle();
    server.respond(0, { error: "Too long", errorData: { max: 1 } });
    await expect(result).rejects.toBeInstanceOf(ConvexError);
    frame.run(() => {
      expect(addNote.ready()).toBe(true);
      expect(addNote.error()).toBeInstanceOf(ConvexError);
      expect((addNote.error() as ConvexError<any>).data).toEqual({ max: 1 });
    });
    await frame.run(() => convex.close());
  });

  test("awaits arguments, and sends none when the action returns nothing", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const calls: unknown[] = [];
    frame.run(() => {
      convex.handleMutation(add, ({ text }) => {
        calls.push(text);
        return `id-${text}`;
      });
      convex.handleMutation(clear, (args) => {
        calls.push(args);
        return null;
      });
    });
    const upload = atom("", "upload");
    const addUploaded = action(async (name: string) => {
      await wrap(Promise.resolve());
      upload.set(name);
      return { text: `uploaded ${name}` };
    }, "addUploaded").extend(withConvexMutation(convex, add));
    const clearNotes = action(() => {}, "clearNotes").extend(
      withConvexMutation(() => convex, clear),
    );

    await expect(frame.run(() => addUploaded("a.png"))).resolves.toBe(
      "id-uploaded a.png",
    );
    await expect(frame.run(() => clearNotes())).resolves.toBeNull();
    expect(calls).toEqual(["uploaded a.png", {}]);
    frame.run(() => {
      expect(upload()).toBe("a.png");
      expect(addUploaded.ready()).toBe(true);
    });
  });

  test("types the action's parameters and result", () => {
    const convex = reatomConvexClientFake();
    const addNote = action((text: string) => ({ text }), "addNote").extend(
      withActions(() => ({ draft: () => "" })),
      withConvexMutation(convex, add),
    );
    expectTypeOf(addNote).parameters.toEqualTypeOf<[text: string]>();
    expectTypeOf(addNote).returns.toEqualTypeOf<Promise<string>>();
    expectTypeOf(addNote.onFulfill).parameter(0).toEqualTypeOf<string>();
    // Other extensions' properties stay.
    expectTypeOf(addNote.draft).toEqualTypeOf<Action<[], string>>();

    action(() => ({ body: "a" }), "wrongArgs").extend(
      // @ts-expect-error notes:add takes a text.
      withConvexMutation(convex, add),
    );
    action(() => {}, "noArgs").extend(
      // @ts-expect-error notes:add has a required argument.
      withConvexMutation(convex, add),
    );
    withConvexMutation(convex, add, {
      // @ts-expect-error The update gets the mutation's arguments.
      optimisticUpdate: (_store, { body }: { body: string }) => body,
    });
  });
});

describe("withConvexAction", () => {
  test("runs the action with the arguments the Reatom action returns", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const sendMail = action((to: string) => ({ to }), "sendMail").extend(
      withConvexAction(convex, send),
    );
    expectTypeOf(sendMail).returns.toEqualTypeOf<Promise<string>>();

    const sent = frame.run(() => sendMail("a@b.c"));
    await settle();
    server.open();
    await settle();
    expect(requests()).toMatchObject([
      { type: "Action", udfPath: "mail:send", args: [{ to: "a@b.c" }] },
    ]);
    frame.run(() => expect(sendMail.ready()).toBe(false));
    server.respond(0, { value: "queued" });
    await expect(sent).resolves.toBe("queued");
    frame.run(() => expect(sendMail.ready()).toBe(true));
    await frame.run(() => convex.close());
  });
});
