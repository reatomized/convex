// The @reatomized/convex/testing entry point: fakes for UI tests and stories.
export {
  loading,
  MissingHandlerError,
  paginate,
  reatomConvexClientFake,
} from "./fake_client.js";
export type {
  ActionHandler,
  FunctionContext,
  MutationHandler,
  QueryHandler,
  ReatomConvexClientFake,
} from "./fake_client.js";
export {
  fakeIdentity,
  fakeToken,
  reatomAuthProviderFake,
  reatomAuthStateFake,
} from "./fake_auth.js";
export type {
  AuthProviderFake,
  AuthProviderFakeOptions,
  ReatomAuthStateFake,
} from "./fake_auth.js";
