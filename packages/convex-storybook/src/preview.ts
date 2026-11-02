// The addon's preview annotations, for a preview that lists annotations
// instead of CSF Next addons.
import { unhandledIn } from "./story.js";

export type {
  ConvexStorybookParameters,
  ConvexStoryParameters,
} from "./story.js";

const annotations = {
  /**
   * Fails a story whose fakes were called without a handler, even when the
   * app caught the error and rendered something plausible.
   */
  afterEach: ({ abortSignal }: { abortSignal: AbortSignal }) => {
    const missing = unhandledIn(abortSignal);
    if (missing.length === 0) return;
    throw new Error(
      [
        "The story called Convex functions without fake handlers:",
        ...missing.map(({ message }) => `- ${message}`),
        "Register them in parameters.convex.setup.",
      ].join("\n"),
    );
  },
};

export default annotations;
