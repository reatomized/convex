import { action, atom, computed, context, noop, wrap } from "@reatom/core";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { ConvexError } from "convex/values";
import { reatomAuthState } from "./auth_state.js";
import { reatomConvexClient, type ReatomConvexClient } from "./client.js";
import { clientOptions, FakeServer, settle } from "./parity_test_helpers.js";
import {
  fakeIdentity,
  fakeToken,
  loading,
  MissingHandlerError,
  paginate,
  reatomAuthProviderFake,
  reatomAuthStateFake,
  reatomConvexClientFake,
  type ReatomConvexClientFake,
} from "./testing.js";

const list = makeFunctionReference<"query", { tag?: string }, string[]>(
  "notes:list",
);
const get = makeFunctionReference<"query", { id: number }, string | null>(
  "notes:get",
);
const add = makeFunctionReference<"mutation", { text: string }, null>(
  "notes:add",
);
const send = makeFunctionReference<"action", { to: string }, string>(
  "mail/outbox:send",
);
const mine = makeFunctionReference<"query", Record<string, never>, string[]>(
  "notes:mine",
);
const page = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<number>
>("notes:page");

afterEach(() => {
  vi.restoreAllMocks();
});

/** Signs a frame up for a fake whose `notes:list` reads a notes atom. */
const withNotes = (frame: ReturnType<typeof context.start>) => {
  const convex = reatomConvexClientFake();
  const notes = atom<string[]>([], "notes");
  frame.run(() => {
    convex.handleQuery(list, ({ tag }) =>
      notes().filter((note) => tag === undefined || note.startsWith(tag)),
    );
    convex.handleMutation(add, ({ text }) => {
      notes.set((all) => [...all, text]);
      return null;
    });
  });
  return { convex, notes };
};

describe("reatomConvexClientFake", () => {
  test("is a ReatomConvexClient", () => {
    expectTypeOf<ReatomConvexClientFake>().toMatchTypeOf<ReatomConvexClient>();
  });

  test("queries follow the atoms their handlers read", async () => {
    const frame = context.start();
    const { convex, notes } = withNotes(frame);
    const query = frame.run(() => convex.query(list, {}));
    const seen: unknown[] = [];
    frame.run(() => query.data.subscribe((value) => seen.push(value)));

    frame.run(() => notes.set(["a"]));
    frame.run(() => {
      expect(query.data()).toEqual(["a"]);
      expect(query.status()).toBe("success");
      expect(query.result()).toEqual({
        success: true,
        value: ["a"],
        logLines: [],
      });
      expect(convex.query(list, {})).toBe(query);
      expect(convex.query(list, { tag: "a" })).not.toBe(query);
    });
    await settle();
    expect(seen).toEqual([[], ["a"]]);
  });

  test("a mutation updates the queries that read what it writes", async () => {
    const frame = context.start();
    const { convex } = withNotes(frame);
    const all = frame.run(() => convex.query(list, {}));
    const tagged = frame.run(() => convex.query(list, { tag: "b" }));
    frame.run(() => {
      all.data.subscribe(noop);
      tagged.data.subscribe(noop);
    });

    const done = frame.run(() => convex.mutation(add, { text: "b1" }));
    frame.run(() => {
      expect(all.data()).toEqual(["b1"]);
      expect(tagged.data()).toEqual(["b1"]);
      expect(convex.connectionState().inflightMutations).toBe(1);
    });
    await expect(done).resolves.toBeNull();
    frame.run(() => {
      expect(convex.connectionState().inflightMutations).toBe(0);
      expect(convex.connectionState().hasInflightRequests).toBe(false);
    });
  });

  test("a query stays loading while its handler returns `loading`", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const ready = atom(false, "ready");
    frame.run(() =>
      convex.handleQuery(get, ({ id }) => (ready() ? `note ${id}` : loading)),
    );
    const note = frame.run(() => convex.query(get, { id: 1 }));
    frame.run(() => {
      expect(note.status()).toBe("loading");
      expect(note.data()).toBeUndefined();
      expect(note.result()).toBeUndefined();
      ready.set(true);
      expect(note.status()).toBe("success");
      expect(note.data()).toBe("note 1");
    });
  });

  test("a handler that throws fails the query with that error", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const failure = atom<Error | null>(null, "failure");
    frame.run(() =>
      convex.handleQuery(get, () => {
        const error = failure();
        if (error) throw error;
        return "fine";
      }),
    );
    const note = frame.run(() => convex.query(get, { id: 1 }));
    frame.run(() => {
      const plain = new Error("Convex is unavailable");
      failure.set(plain);
      expect(note.status()).toBe("error");
      expect(note.error()).toBe(plain);
      expect(note.data()).toBeUndefined();

      const typed = new ConvexError({ code: "NOT_FOUND" });
      failure.set(typed);
      expect(note.error()).toBe(typed);
      expect(note.result()).toMatchObject({
        success: false,
        errorData: { code: "NOT_FOUND" },
      });

      failure.set(null);
      expect(note.status()).toBe("success");
    });
  });

  test("results arrive as Convex values", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const value = atom<unknown>(undefined, "value");
    frame.run(() => {
      convex.handleQuery(get, () => value() as string);
      convex.handleMutation(add, () => new Date() as never);
    });
    const note = frame.run(() => convex.query(get, { id: 1 }));
    frame.run(() => {
      expect(note.data()).toBeNull();
      value.set({ kept: 1, dropped: undefined });
      expect(note.data()).toEqual({ kept: 1 });
      value.set(new Map());
      expect(() => note.data()).toThrow(
        "The fake query handler for notes:get returned a value Convex can't send",
      );
    });
    await expect(
      frame.run(() => convex.mutation(add, { text: "a" })),
    ).rejects.toThrow("returned a value Convex can't send");
  });

  test("a query handler that returns a promise fails loudly", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    frame.run(() =>
      convex.handleQuery(get, (() => Promise.resolve("late")) as never),
    );
    expect(() =>
      frame.run(() => convex.query(get, { id: 1 }).status()),
    ).toThrow("Query handlers are synchronous");
  });

  test("mutation and action errors reject with the thrown error", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const typed = new ConvexError("Note text is required");
    frame.run(() => {
      convex.handleMutation(add, () => {
        throw typed;
      });
      convex.handleAction(send, async ({ to }) => `sent to ${to}`);
    });
    await expect(
      frame.run(() => convex.mutation(add, { text: "" })),
    ).rejects.toBe(typed);
    await expect(
      frame.run(() => convex.action(send, { to: "olga" })),
    ).resolves.toBe("sent to olga");
  });

  test("a function without a handler throws, logs and is listed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(noop);
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const query = frame.run(() => convex.query(list, {}));
    const read = () => frame.run(() => query.data());
    expect(read).toThrow(MissingHandlerError);
    expect(read).toThrow(
      "No fake handler for query notes:list. Register one with handleQuery(api.notes.list, ...).",
    );
    // Swallowing the throw doesn't hide it: it's logged and listed.
    const caught = action(async () => {
      try {
        await wrap(convex.action(send, { to: "olga" }));
      } catch {
        return "toast";
      }
    }, "caught");
    await expect(frame.run(() => caught())).resolves.toBe("toast");
    expect(() => frame.run(() => convex.mutation(add, { text: "a" }))).toThrow(
      MissingHandlerError,
    );
    expect(convex.unhandled.map(({ message }) => message)).toEqual([
      "No fake handler for query notes:list. Register one with handleQuery(api.notes.list, ...).",
      "No fake handler for action mail/outbox:send. Register one with handleAction(api.mail.outbox.send, ...).",
      "No fake handler for mutation notes:add. Register one with handleMutation(api.notes.add, ...).",
    ]);
    expect(errors).toHaveBeenCalledTimes(3);

    frame.run(() => convex.handleQuery(list, () => ["late"]));
    expect(read()).toEqual(["late"]);
  });

  test("replacing a handler re-runs the queries using it", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    frame.run(() => convex.handleQuery(get, () => "first"));
    const note = frame.run(() => convex.query(get, { id: 1 }));
    frame.run(() => note.data.subscribe(noop));
    frame.run(() => convex.handleQuery(get, () => "second"));
    expect(frame.run(() => note.data())).toBe("second");
  });

  test("each frame has its own handlers and state", async () => {
    const convex = reatomConvexClientFake();
    const notes = atom<string[]>([], "notes");
    const first = context.start();
    const second = context.start();
    for (const frame of [first, second]) {
      frame.run(() => {
        convex.handleQuery(list, () => notes());
        convex.handleMutation(add, ({ text }) => {
          notes.set((all) => [...all, text]);
          return null;
        });
      });
    }
    await first.run(() => convex.mutation(add, { text: "only first" }));
    expect(first.run(() => convex.query(list, {}).data())).toEqual([
      "only first",
    ]);
    expect(second.run(() => convex.query(list, {}).data())).toEqual([]);

    const third = context.start();
    expect(() => third.run(() => convex.query(list, {}).data())).toThrow(
      MissingHandlerError,
    );
  });

  test("handlers see the identity of the accepted token", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const provider = reatomAuthProviderFake({
      identity: fakeIdentity("alex", { email: "alex@example.com" }),
    });
    const auth = reatomAuthState(convex, provider);
    frame.run(() =>
      convex.handleQuery(mine, (_args, { identity }) =>
        identity ? [`${identity.email}'s note`] : [],
      ),
    );
    const notes = frame.run(() => convex.query(mine, {}));
    const statuses: string[] = [];
    frame.run(() => {
      auth.status.subscribe((status) => statuses.push(status));
      notes.data.subscribe(noop);
    });
    await settle();
    frame.run(() => {
      expect(auth.status()).toBe("authenticated");
      expect(notes.data()).toEqual(["alex@example.com's note"]);
      expect(convex.identity()).toEqual({
        tokenIdentifier: "https://convex.fake|alex",
        subject: "alex",
        issuer: "https://convex.fake",
        email: "alex@example.com",
      });
      expect(convex.authClaims()?.decoded).toMatchObject({
        sub: "alex",
        email: "alex@example.com",
      });
    });

    frame.run(() => provider.identity.set(null));
    await settle();
    frame.run(() => {
      expect(auth.status()).toBe("unauthenticated");
      expect(convex.identity()).toBeNull();
      expect(notes.data()).toEqual([]);
    });
    expect(statuses).toEqual(["loading", "authenticated", "unauthenticated"]);
  });

  test("the provider fake drives reatomAuthState through every status", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const status = (provider: ReturnType<typeof reatomAuthProviderFake>) => {
      const auth = reatomAuthState(convex, provider);
      frame.run(() => auth.status.subscribe(noop));
      return () => frame.run(() => auth.status());
    };

    const restoring = status(reatomAuthProviderFake({ isLoading: true }));
    await settle();
    expect(restoring()).toBe("loading");

    const signedOut = status(reatomAuthProviderFake());
    await settle();
    expect(signedOut()).toBe("unauthenticated");

    const refused = status(
      reatomAuthProviderFake({
        identity: fakeIdentity("mallory"),
        fetchToken: async () => null,
      }),
    );
    await settle();
    expect(refused()).toBe("rejected");
  });

  test("a later setAuth or clearAuth wins over a pending token", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    let release!: (token: string) => void;
    frame.run(() =>
      convex.setAuth(() => new Promise((resolve) => (release = resolve))),
    );
    expect(frame.run(() => convex.isAuthenticated())).toBeNull();
    frame.run(() => convex.clearAuth());
    release(fakeToken(fakeIdentity("late")));
    await settle();
    frame.run(() => {
      expect(convex.isAuthenticated()).toBe(false);
      expect(convex.identity()).toBeNull();
    });
  });

  test("paginated queries page through a handler's results", async () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const items = atom([1, 2, 3, 4, 5], "items");
    frame.run(() =>
      convex.handleQuery(page, ({ paginationOpts }) =>
        paginate(items(), paginationOpts),
      ),
    );
    const pages = frame.run(() =>
      convex.paginatedQuery(page, {}, { initialNumItems: 2 }),
    );
    frame.run(() => {
      pages.results.subscribe(noop);
      expect(pages.results()).toEqual([1, 2]);
      expect(pages.status()).toBe("CanLoadMore");
      expect(pages.loadMore(10)).toBe(true);
      expect(pages.results()).toEqual([1, 2, 3, 4, 5]);
      expect(pages.status()).toBe("Exhausted");
      items.set([0, 1, 2, 3, 4, 5]);
      expect(pages.results()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(convex.paginatedQuery(page, {}, { initialNumItems: 2 })).toBe(
        pages,
      );
    });
  });

  test("connected sets what connectionState reports", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    frame.run(() => {
      expect(convex.connectionState()).toMatchObject({
        isWebSocketConnected: true,
        hasEverConnected: true,
      });
      convex.connected.set(false);
      expect(convex.connectionState().isWebSocketConnected).toBe(false);
    });
  });

  test("close resolves", async () => {
    const frame = context.start();
    await expect(
      frame.run(() => reatomConvexClientFake().close()),
    ).resolves.toBeUndefined();
  });
});

describe("paginate", () => {
  test("cuts pages at offsets and stops at the end", () => {
    const items = ["a", "b", "c"];
    expect(paginate(items, { cursor: null, numItems: 2 })).toEqual({
      page: ["a", "b"],
      isDone: false,
      continueCursor: "2",
    });
    expect(paginate(items, { cursor: "2", numItems: 2 })).toEqual({
      page: ["c"],
      isDone: true,
      continueCursor: "3",
    });
    expect(
      paginate(items, { cursor: "0", numItems: 5, endCursor: "1" }),
    ).toMatchObject({ page: ["a"], isDone: false });
  });
});

describe("reatomAuthStateFake", () => {
  test("derives isLoading and isAuthenticated from a settable status", () => {
    const frame = context.start();
    const auth = reatomAuthStateFake("loading");
    frame.run(() => {
      expect(auth.isLoading()).toBe(true);
      expect(auth.isAuthenticated()).toBe(false);
      auth.status.set("authenticated");
      expect(auth.isLoading()).toBe(false);
      expect(auth.isAuthenticated()).toBe(true);
      auth.status.set("rejected");
      expect(auth.isAuthenticated()).toBe(false);
      auth.isRefreshing.set(true);
      expect(auth.isRefreshing()).toBe(true);
    });
  });
});

describe("fakeToken", () => {
  test("carries the identity's claims under their OIDC names", () => {
    const frame = context.start();
    const convex = reatomConvexClientFake();
    const identity = fakeIdentity("sam", {
      issuer: "https://auth.example.com",
      givenName: "Sam",
      emailVerified: true,
      provider: "better-auth",
    });
    const token = fakeToken(identity);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    expect(claims).toMatchObject({
      sub: "sam",
      iss: "https://auth.example.com",
      given_name: "Sam",
      email_verified: true,
      provider: "better-auth",
    });
    frame.run(() => convex.setAuth(async () => token));
    return settle().then(() =>
      expect(frame.run(() => convex.identity())).toEqual(identity),
    );
  });
});

/**
 * Consumer code written against `ReatomConvexClient`: a derived list and an
 * action that adds to it.
 */
const notesModel = (convex: ReatomConvexClient) => ({
  titles: computed(
    () =>
      convex
        .query(list, {})
        .data()
        ?.map((note) => note.toUpperCase()),
    "titles",
  ),
  addNote: action(
    async (text: string) => wrap(convex.mutation(add, { text })),
    "addNote",
  ),
});

describe("the same consumer code on both clients", () => {
  test("sees the same titles and mutation result", async () => {
    // The real client, answered by the scripted server.
    const server = new FakeServer([]);
    const realFrame = context.start();
    const real = reatomConvexClient(
      "https://happy-otter-123.convex.cloud",
      clientOptions(server),
    );
    const realModel = notesModel(real);
    const realSeen: unknown[] = [];
    realFrame.run(() =>
      realModel.titles.subscribe((titles) => realSeen.push(titles)),
    );
    await settle();
    server.open();
    server.transition([["notes:list", {}, { value: ["a"] }]]);
    const realAdded = realFrame.run(() => realModel.addNote("b"));
    await settle();
    server.respond(0, { value: null });
    server.transition([["notes:list", {}, { value: ["a", "b"] }]]);
    const realResult = await realAdded;
    await realFrame.run(() => real.close());

    // The fake, answered by handlers over an atom.
    const fakeFrame = context.start();
    const { convex: fake, notes } = withNotes(fakeFrame);
    const ready = atom(false, "ready");
    fakeFrame.run(() =>
      fake.handleQuery(list, () => (ready() ? notes() : loading)),
    );
    const fakeModel = notesModel(fake);
    const fakeSeen: unknown[] = [];
    fakeFrame.run(() =>
      fakeModel.titles.subscribe((titles) => fakeSeen.push(titles)),
    );
    fakeFrame.run(() => {
      notes.set(["a"]);
      ready.set(true);
    });
    await settle();
    const fakeResult = await fakeFrame.run(() => fakeModel.addNote("b"));
    await settle();

    expect(fakeSeen).toEqual(realSeen);
    expect(realSeen).toEqual([undefined, ["A"], ["A", "B"]]);
    expect(fakeResult).toEqual(realResult);
  });
});
