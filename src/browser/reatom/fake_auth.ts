/**
 * Auth fakes: identities carried in unsigned JWTs, an auth library session for
 * `reatomAuthState`, and an auth state with a settable status.
 */
import { atom, computed, type Atom, type Computed } from "@reatom/core";
import type { UserIdentity } from "convex/server";
import { jwtDecode } from "../../vendor/jwt-decode/index.js";
import type { AuthTokenFetcher } from "./auth.js";
import type {
  AuthProvider,
  AuthStatus,
  ReatomAuthState,
} from "./auth_state.js";

const FAKE_ISSUER = "https://convex.fake";

/** `UserIdentity` fields and the OIDC claims Convex reads them from. */
const CLAIMS = {
  givenName: "given_name",
  familyName: "family_name",
  preferredUsername: "preferred_username",
  profileUrl: "profile",
  pictureUrl: "picture",
  emailVerified: "email_verified",
  birthday: "birthdate",
  timezone: "zoneinfo",
  language: "locale",
  phoneNumber: "phone_number",
  phoneNumberVerified: "phone_number_verified",
  updatedAt: "updated_at",
} as const satisfies Partial<Record<keyof UserIdentity, string>>;
const FIELDS: Record<string, string> = Object.fromEntries(
  Object.entries(CLAIMS).map(([field, claim]) => [claim, field]),
);
const RESERVED = new Set(["sub", "iss", "aud", "exp", "iat", "nbf", "jti"]);

/**
 * A `UserIdentity` for `subject`, with `issuer` `https://convex.fake` unless
 * `claims` names another.
 *
 * @public
 */
export function fakeIdentity(
  subject: string,
  claims: Omit<Partial<UserIdentity>, "subject" | "tokenIdentifier"> = {},
): UserIdentity {
  const issuer =
    typeof claims.issuer === "string" ? claims.issuer : FAKE_ISSUER;
  return {
    ...claims,
    subject,
    issuer,
    tokenIdentifier: `${issuer}|${subject}`,
  };
}

const base64url = (json: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/**
 * An unsigned JWT carrying `identity` as OIDC claims, valid for an hour.
 * `reatomConvexClientFake` reads the identity back from it.
 *
 * @public
 */
export function fakeToken(identity: UserIdentity): string {
  const { tokenIdentifier: _, subject, issuer, ...fields } = identity;
  const claims: Record<string, unknown> = { sub: subject, iss: issuer };
  for (const [field, value] of Object.entries(fields)) {
    claims[CLAIMS[field as keyof typeof CLAIMS] ?? field] = value;
  }
  const iat = Math.floor(Date.now() / 1000);
  claims.iat = iat;
  claims.exp = iat + 3600;
  return [
    base64url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64url(JSON.stringify(claims)),
    "",
  ].join(".");
}

/**
 * The identity Convex derives from a JWT's claims. A token that isn't a JWT
 * becomes an identity whose subject is the token.
 */
export function identityFromToken(token: string): UserIdentity {
  let claims: Record<string, unknown>;
  try {
    claims = jwtDecode<Record<string, unknown>>(token);
  } catch {
    return fakeIdentity(token);
  }
  const fields: Record<string, unknown> = {};
  for (const [claim, value] of Object.entries(claims)) {
    if (!RESERVED.has(claim)) fields[FIELDS[claim] ?? claim] = value;
  }
  return fakeIdentity(typeof claims.sub === "string" ? claims.sub : token, {
    ...fields,
    issuer: typeof claims.iss === "string" ? claims.iss : FAKE_ISSUER,
  } as Omit<Partial<UserIdentity>, "subject" | "tokenIdentifier">);
}

/**
 * An auth library session for `reatomAuthState`, set from a test.
 *
 * @public
 */
export interface AuthProviderFake extends AuthProvider {
  /** The signed-in user, `null` when signed out. */
  readonly identity: Atom<UserIdentity | null>;
  readonly isLoading: Atom<boolean>;
  /** The identity's `tokenIdentifier`. */
  readonly session: Computed<string | null>;
}

/** @public */
export type AuthProviderFakeOptions = {
  identity?: UserIdentity | null | undefined;
  isLoading?: boolean | undefined;
  /**
   * Replaces the token fetch, which returns `fakeToken(identity)`. A fetch
   * that returns `null` makes `reatomAuthState` report `rejected`.
   */
  fetchToken?: AuthTokenFetcher | undefined;
};

/**
 * A fake auth library for `reatomAuthState(convex, provider)`. Its token
 * carries `identity`, so `reatomConvexClientFake` hands that identity to
 * function handlers once `setAuth` accepts the token.
 *
 * ```ts
 * const provider = reatomAuthProviderFake({ identity: fakeIdentity("alex") });
 * const auth = reatomAuthState(convex, provider);
 * provider.identity.set(null); // signs out
 * ```
 *
 * @public
 */
export function reatomAuthProviderFake(
  options: AuthProviderFakeOptions = {},
  name = "authProviderFake",
): AuthProviderFake {
  const identity = atom<UserIdentity | null>(
    options.identity ?? null,
    `${name}.identity`,
  );
  return {
    identity,
    isLoading: atom(options.isLoading ?? false, `${name}.isLoading`),
    session: computed(
      () => identity()?.tokenIdentifier ?? null,
      `${name}.session`,
    ),
    fetchToken:
      options.fetchToken ??
      (() => {
        const current = identity();
        return Promise.resolve(current ? fakeToken(current) : null);
      }),
  };
}

/**
 * The shape `reatomAuthState` returns, with a settable `status`.
 *
 * @public
 */
export interface ReatomAuthStateFake extends ReatomAuthState {
  readonly status: Atom<AuthStatus>;
  readonly isRefreshing: Atom<boolean>;
}

/**
 * An auth state that reports `status` without a client or auth library.
 * `isLoading` and `isAuthenticated` follow `status`.
 *
 * ```ts
 * const auth = reatomAuthStateFake("loading");
 * auth.status.set("rejected");
 * ```
 *
 * @public
 */
export function reatomAuthStateFake(
  status: AuthStatus = "authenticated",
  name = "authStateFake",
): ReatomAuthStateFake {
  const current = atom<AuthStatus>(status, `${name}.status`);
  return {
    status: current,
    isLoading: computed(() => current() === "loading", `${name}.isLoading`),
    isAuthenticated: computed(
      () => current() === "authenticated",
      `${name}.isAuthenticated`,
    ),
    isRefreshing: atom(false, `${name}.isRefreshing`),
  };
}
