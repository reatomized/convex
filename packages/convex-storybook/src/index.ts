// No runtime import of `storybook`: `definePreviewAddon` only returns its
// argument, so the addon is its annotations typed as a `PreviewAddon`.
import type { PreviewAddon } from "storybook/internal/csf";
import annotations from "./preview.js";
import type { ConvexStorybookParameters } from "./story.js";

/**
 * The addon for a CSF Next preview: types `parameters.convex` and fails a
 * story that called a Convex function without a handler. The app installs the
 * fakes itself, with {@link convexStory}.
 */
export default function convexStorybook(): PreviewAddon<{
  parameters: ConvexStorybookParameters;
}> {
  return annotations;
}

export { convexStory } from "./story.js";
export type {
  ConvexStoryContext,
  ConvexStoryFake,
  ConvexStorybookParameters,
  ConvexStoryParameters,
} from "./story.js";
