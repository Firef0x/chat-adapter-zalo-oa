import { emoji } from "chat";
import { describe, expect, it } from "vitest";

import {
  fromZaloReactIcon,
  supportedReactions,
  toZaloReactIcon,
  ZALO_REACTIONS,
} from "../../src/lib/reactions.js";

describe("reactions", () => {
  it.each([
    ["/-strong", "thumbs_up"],
    ["/-heart", "heart"],
    [":>", "laugh"],
    [":o", "surprised"],
    [":-((", "cry"],
    [":-h", "angry"],
  ])("maps %s to and from %s", (icon, name) => {
    expect(fromZaloReactIcon(icon).name).toBe(name);
    expect(toZaloReactIcon(name)).toBe(icon);
    expect(toZaloReactIcon(emoji[name as "heart"])).toBe(icon);
    expect(toZaloReactIcon(icon)).toBe(icon);
  });

  it("covers exactly the seven icons Zalo documents", () => {
    expect(new Set(Object.keys(ZALO_REACTIONS))).toEqual(
      new Set(["--b", "/-heart", "/-strong", ":-((", ":-h", ":>", ":o"]),
    );
  });

  it("keeps --b under its own code rather than guessing a name", () => {
    expect(fromZaloReactIcon("--b").name).toBe("--b");
    expect(toZaloReactIcon("--b")).toBe("--b");
  });

  it("returns a custom emoji for an unknown icon", () => {
    expect(fromZaloReactIcon(":new:").name).toBe(":new:");
  });

  it.each([
    ["👍", "/-strong"],
    ["❤️", "/-heart"],
    ["❤", "/-heart"],
    ["😂", ":>"],
    ["😆", ":>"],
    ["😮", ":o"],
    ["😭", ":-(("],
    ["😠", ":-h"],
  ])("accepts the Unicode emoji %s", (value, icon) => {
    expect(toZaloReactIcon(value)).toBe(icon);
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "does not mistake the inherited name %s for an icon",
    (value) => {
      expect(toZaloReactIcon(value)).toBeNull();
      expect(fromZaloReactIcon(value).name).toBe(value);
    },
  );

  it.each(["rocket", "/-remove", "", "Heart", "🚀"])("has no icon for %j", (value) => {
    expect(toZaloReactIcon(value)).toBeNull();
  });

  it("lists every option for error messages", () => {
    expect(supportedReactions()).toBe(
      "thumbs_up (/-strong), heart (/-heart), laugh (:>), surprised (:o), cry (:-((), angry (:-h), --b",
    );
  });
});
