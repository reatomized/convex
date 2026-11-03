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
  updateQuery,
  withConvexAction,
  withConvexMutation,
  withConvexPaginatedQuery,
  withConvexQuery,
  type ConvexPagePosition,
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

  test("refuses an atom that already has one of its atoms", () => {
    const convex = reatomConvexClientFake();
    const taken = atom({ id: 1 }, "taken").extend(() => ({ status: 1 }));
    expect(() => taken.extend(withConvexQuery(convex, get))).toThrow(
      "taken already has status",
    );
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

describe("withConvexQuery on an action", () => {
  test("reads the query once and unsubscribes", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const loadNote = action((id: number) => ({ id }), "loadNote").extend(
      withConvexQuery(convex, get),
    );
    expectTypeOf(loadNote).returns.toEqualTypeOf<Promise<string>>();

    const loaded = frame.run(() => loadNote(1));
    frame.run(() => expect(loadNote.ready()).toBe(false));
    await settle();
    server.open();
    expect(server.querySet()).toEqual([
      JSON.stringify({ udfPath: "notes:get", args: { id: 1 } }),
    ]);
    server.transition([["notes:get", { id: 1 }, { value: "one" }]]);
    await expect(loaded).resolves.toBe("one");
    await settle();
    expect(server.querySet()).toEqual([]);
    frame.run(() => expect(loadNote.ready()).toBe(true));
    await frame.run(() => convex.close());
  });

  test("resolves with a result another reader holds", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const note = atom({ id: 1 }, "note").extend(withConvexQuery(convex, get));
    const loadNote = action((id: number) => ({ id }), "loadNote").extend(
      withConvexQuery(convex, get),
    );
    frame.run(() => note.data.subscribe(noop));
    await settle();
    server.open();
    server.transition([["notes:get", { id: 1 }, { value: "one" }]]);

    await expect(frame.run(() => loadNote(1))).resolves.toBe("one");
    await settle();
    // The atom's subscription stays.
    expect(server.querySet()).toHaveLength(1);
    await frame.run(() => convex.close());
  });

  test("rejects with the error the query failed with", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const loadNote = action((id: number) => ({ id }), "loadNote").extend(
      withConvexQuery(convex, get),
    );
    const loaded = frame.run(() => loadNote(1));
    await settle();
    server.open();
    server.transition([
      ["notes:get", { id: 1 }, { error: "missing", errorData: { id: 1 } }],
    ]);
    await expect(loaded).rejects.toBeInstanceOf(ConvexError);
    frame.run(() => {
      expect((loadNote.error() as ConvexError<any>).data).toEqual({ id: 1 });
    });
    await settle();
    expect(server.querySet()).toEqual([]);
    await frame.run(() => convex.close());
  });

  test("checks what the action returns", () => {
    const convex = reatomConvexClientFake();
    expectTypeOf(
      action(() => ({ id: "1" }), "wrongId").extend(
        withConvexQuery(convex, get),
      ),
    ).toHaveProperty("withConvexQuery_ERROR");
    expectTypeOf(
      action(() => {}, "noArgs").extend(withConvexQuery(convex, list)),
    ).returns.toEqualTypeOf<Promise<string[]>>();
  });
});

describe("updateQuery", () => {
  test("updates a query atom's value while the mutation is pending", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const notes = atom({ tag: "a" }, "notes").extend(
      withConvexQuery(convex, list),
    );
    const other = atom({}, "other").extend(withConvexQuery(convex, list));
    const calls: unknown[] = [];
    const addNote = action((text: string) => ({ text }), "addNote").extend(
      withConvexMutation(convex, add, {
        optimisticUpdate: [
          (_store, args) => calls.push(args),
          updateQuery(notes, (current, { text }) => [...current, text]),
        ],
      }),
    );
    frame.run(() => {
      notes.data.subscribe(noop);
      other.data.subscribe(noop);
    });
    await settle();
    server.open();
    server.transition([
      ["notes:list", { tag: "a" }, { value: ["a1"] }],
      ["notes:list", {}, { value: ["a1", "b1"] }],
    ]);

    const result = frame.run(() => addNote("a2"));
    frame.run(() => {
      expect(notes.data()).toEqual(["a1", "a2"]);
      // Only the atom's arguments change.
      expect(other.data()).toEqual(["a1", "b1"]);
    });
    expect(calls).toEqual([{ text: "a2" }]);
    await settle();
    server.respond(0, { value: "id" });
    server.transition([["notes:list", { tag: "a" }, { value: ["a1", "a2"] }]]);
    await expect(result).resolves.toBe("id");
    frame.run(() => expect(notes.data()).toEqual(["a1", "a2"]));
    await frame.run(() => convex.close());
  });

  test("updates each loaded page of a paginated atom", async () => {
    const frame = context.start();
    const convex = reatomConvexClient(URL, clientOptions(server));
    const pages = atom({ tag: "a" }, "pages").extend(
      withConvexPaginatedQuery(convex, page, { initialNumItems: 2 }),
    );
    const addFirst = action(
      (n: number) => ({ text: String(n) }),
      "addFirst",
    ).extend(
      withConvexMutation(convex, add, {
        optimisticUpdate: updateQuery(
          pages,
          (items, { text }, { first, last }) =>
            first
              ? [Number(text), ...items]
              : last
                ? [...items, -Number(text)]
                : items,
        ),
      }),
    );
    frame.run(() => pages.results.subscribe(noop));
    await settle();
    server.open();
    server.transition([
      [
        "notes:page",
        { tag: "a", paginationOpts: { cursor: null, numItems: 2, id: -1 } },
        { value: { page: [1, 2], isDone: false, continueCursor: "c" } },
      ],
    ]);
    frame.run(() => pages.loadMore(2));
    await settle();
    server.transition([
      [
        "notes:page",
        { tag: "a", paginationOpts: { cursor: "c", numItems: 2, id: -1 } },
        { value: { page: [3], isDone: true, continueCursor: "e" } },
      ],
    ]);

    void frame.run(() => addFirst(9));
    frame.run(() => expect(pages.results()).toEqual([9, 1, 2, 3, -9]));
    await frame.run(() => convex.close());
  });

  test("updates a fake's query while its handler is pending", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const stored = atom<string[]>([], "stored");
    let release!: () => void;
    frame.run(() => {
      convex.handleQuery(list, () => stored());
      convex.handleMutation(add, async ({ text }) => {
        await wrap(new Promise<void>((resolve) => (release = resolve)));
        stored.set((all) => [...all, text]);
        return text;
      });
    });
    const notes = atom({}, "notes").extend(withConvexQuery(convex, list));
    const addNote = action((text: string) => ({ text }), "addNote").extend(
      withConvexMutation(convex, add, {
        optimisticUpdate: updateQuery(notes, (current, { text }) => [
          ...current,
          `${text}?`,
        ]),
      }),
    );
    frame.run(() => notes.data.subscribe(noop));
    const done = frame.run(() => addNote("a"));
    frame.run(() => expect(notes.data()).toEqual(["a?"]));
    release();
    await expect(done).resolves.toBe("a");
    frame.run(() => expect(notes.data()).toEqual(["a"]));
  });

  test("leaves a skipped atom alone", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    frame.run(() => convex.handleMutation(add, ({ text }) => text));
    const notes = atom<{ tag: string } | "skip">("skip", "notes").extend(
      withConvexQuery(convex, list),
    );
    const update = vi.fn((current: string[]) => current);
    const addNote = action((text: string) => ({ text }), "addNote").extend(
      withConvexMutation(convex, add, {
        optimisticUpdate: updateQuery(notes, update),
      }),
    );
    await expect(frame.run(() => addNote("a"))).resolves.toBe("a");
    expect(update).not.toHaveBeenCalled();
  });

  test("takes only atoms extended with a query extension", () => {
    expect(() =>
      updateQuery(atom({}, "plain") as never, (current: unknown) => current),
    ).toThrow("updateQuery takes an atom extended with withConvexQuery");
  });

  test("types the value, the page and the mutation's arguments", () => {
    const convex = reatomConvexClientFake();
    const notes = atom({}, "notes").extend(withConvexQuery(convex, list));
    const pages = atom({ tag: "a" }, "pages").extend(
      withConvexPaginatedQuery(convex, page, { initialNumItems: 1 }),
    );
    withConvexMutation(convex, add, {
      optimisticUpdate: [
        updateQuery(notes, (current, args) => {
          expectTypeOf(current).toEqualTypeOf<string[]>();
          expectTypeOf(args).toEqualTypeOf<{ text: string }>();
          return current;
        }),
        updateQuery(pages, (items, args, position) => {
          expectTypeOf(items).toEqualTypeOf<number[]>();
          expectTypeOf(args).toEqualTypeOf<{ text: string }>();
          expectTypeOf(position).toEqualTypeOf<ConvexPagePosition>();
          return items;
        }),
      ],
    });
    withConvexMutation(convex, add, {
      // @ts-expect-error notes:list holds strings.
      optimisticUpdate: updateQuery(notes, () => [1]),
    });
  });
});

describe("keepPreviousData", () => {
  test("keeps a query's value while the new arguments load", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const ready = atom(new Set([1]), "ready");
    frame.run(() =>
      convex.handleQuery(get, ({ id }) =>
        ready().has(id) ? `note ${id}` : loading,
      ),
    );
    const id = atom<number | null>(1, "id");
    const args = computed(() => {
      const current = id();
      return current === null ? "skip" : { id: current };
    }, "args");
    const stable = args.extend(
      withConvexQuery(convex, get, { keepPreviousData: true }),
    );
    frame.run(() => {
      stable.data.subscribe(noop);
      expect(stable.data()).toBe("note 1");
      id.set(2);
      expect(stable.status()).toBe("loading");
      expect(stable.data()).toBe("note 1");
      ready.set(new Set([1, 2]));
      expect(stable.data()).toBe("note 2");
      // Skipping clears it.
      id.set(null);
      expect(stable.data()).toBeUndefined();
    });
  });

  test("keeps a paginated query's items while the first new page loads", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const loaded = atom(new Set(["a"]), "loaded");
    frame.run(() =>
      convex.handleQuery(page, ({ tag, paginationOpts }) =>
        loaded().has(tag)
          ? paginate(tag === "a" ? [1, 2] : [3, 4], paginationOpts)
          : loading,
      ),
    );
    const tag = atom("a", "tag");
    const pages = computed(() => ({ tag: tag() }), "pages").extend(
      withConvexPaginatedQuery(convex, page, {
        initialNumItems: 5,
        keepPreviousData: true,
      }),
    );
    frame.run(() => {
      pages.results.subscribe(noop);
      expect(pages.results()).toEqual([1, 2]);
      tag.set("b");
      expect(pages.status()).toBe("LoadingFirstPage");
      expect(pages.results()).toEqual([1, 2]);
      loaded.set(new Set(["a", "b"]));
      expect(pages.results()).toEqual([3, 4]);
    });
  });
});
