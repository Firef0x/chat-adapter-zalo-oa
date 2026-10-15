import type { EmojiValue, WellKnownEmoji } from "chat";
import { DEFAULT_EMOJI_MAP, emoji, getEmoji } from "chat";

import { lookup } from "./lookup.js";

/** The value Zalo uses to withdraw a reaction. It names no emoji. */
export const ZALO_REMOVE_REACTION = "/-remove";

/**
 * Zalo's reaction icons and the Chat SDK emoji each one is.
 *
 * Zalo offers a fixed set. `--b` has no documented meaning, so rather than
 * guess a name for it, it is exposed as a custom emoji under its own code.
 */
export const ZALO_REACTIONS: Readonly<Record<string, WellKnownEmoji | null>> = {
  "/-strong": "thumbs_up",
  "/-heart": "heart",
  ":>": "laugh",
  ":o": "surprised",
  ":-((": "cry",
  ":-h": "angry",
  "--b": null,
};

/** Whether a Unicode emoji is one of the forms Chat SDK lists for a well-known name. */
function isUnicodeFor(name: WellKnownEmoji, value: string): boolean {
  const forms = DEFAULT_EMOJI_MAP[name]?.gchat;
  return Array.isArray(forms) ? forms.includes(value) : forms === value;
}

/**
 * The Zalo icon for an emoji, or `null` when Zalo has no equivalent.
 *
 * Accepts a well-known emoji (`emoji.heart` or `"heart"`), its Unicode form
 * (`"❤️"`), or a Zalo icon code itself (`"/-heart"`), which is the only way
 * to send `--b`.
 */
export function toZaloReactIcon(value: EmojiValue | string): string | null {
  const name = typeof value === "string" ? value : value.name;
  if (lookup(ZALO_REACTIONS, name) !== undefined) {
    return name;
  }
  for (const [icon, wellKnown] of Object.entries(ZALO_REACTIONS)) {
    if (wellKnown && (wellKnown === name || isUnicodeFor(wellKnown, name))) {
      return icon;
    }
  }
  return null;
}

/** The Chat SDK emoji for a Zalo icon, falling back to a custom emoji named by the code. */
export function fromZaloReactIcon(icon: string): EmojiValue {
  const wellKnown = lookup(ZALO_REACTIONS, icon);
  return wellKnown ? getEmoji(wellKnown) : emoji.custom(icon);
}

/** Every value `addReaction` accepts, for error messages. */
export function supportedReactions(): string {
  return Object.entries(ZALO_REACTIONS)
    .map(([icon, wellKnown]) => (wellKnown ? `${wellKnown} (${icon})` : icon))
    .join(", ");
}
