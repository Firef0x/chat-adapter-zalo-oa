import { ValidationError } from "@chat-adapter/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZaloOaAdapter } from "../src/adapter.js";
import { createZaloOaAdapter, zaloOa } from "../src/factory.js";

const CONFIG = {
  appId: "app_1",
  appSecret: "secret_1",
  oaSecretKey: "oa_secret",
  oaId: "42",
  accessToken: "acc_1",
  refreshToken: "ref_1",
};

const ENV = {
  ZALO_OA_APP_ID: "env_app",
  ZALO_OA_APP_SECRET: "env_secret",
  ZALO_OA_SECRET_KEY: "env_oa_secret",
  ZALO_OA_ID: "77",
  ZALO_OA_ACCESS_TOKEN: "env_acc",
  ZALO_OA_REFRESH_TOKEN: "env_ref",
};

describe("createZaloOaAdapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds an adapter from explicit config", () => {
    const adapter = createZaloOaAdapter(CONFIG);
    expect(adapter).toBeInstanceOf(ZaloOaAdapter);
    expect(adapter.botUserId).toBe("42");
    expect(adapter.name).toBe("zalo-oa");
  });

  it("falls back to environment variables", () => {
    for (const [key, value] of Object.entries(ENV)) {
      vi.stubEnv(key, value);
    }
    expect(createZaloOaAdapter().botUserId).toBe("77");
  });

  it("prefers explicit config over the environment", () => {
    vi.stubEnv("ZALO_OA_ID", "77");
    expect(createZaloOaAdapter(CONFIG).botUserId).toBe("42");
  });

  it.each(Object.keys(CONFIG))("names the missing %s and its env var", (key) => {
    for (const envKey of Object.keys(ENV)) {
      vi.stubEnv(envKey, "");
    }
    const config = { ...CONFIG, [key]: "" };
    expect(() => createZaloOaAdapter(config)).toThrow(ValidationError);
    expect(() => createZaloOaAdapter(config)).toThrow(new RegExp(`${key} is required`));
  });

  it("exports zaloOa as a shorthand", () => {
    expect(zaloOa).toBe(createZaloOaAdapter);
  });
});

describe("ZaloOaAdapter constructor", () => {
  it.each(Object.keys(CONFIG))("refuses an empty %s when built directly", (key) => {
    expect(() => new ZaloOaAdapter({ ...CONFIG, [key]: "" })).toThrow(ValidationError);
  });
});
