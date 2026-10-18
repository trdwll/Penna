import { StateEffect } from "@codemirror/state";

/** Redraw Preview's images, tables and embeds (a file or note they show changed). */
export const refreshPreview = StateEffect.define<null>();
