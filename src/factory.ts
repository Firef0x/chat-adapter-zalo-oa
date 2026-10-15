import { ValidationError } from "@chat-adapter/shared";

import { ZaloOaAdapter } from "./adapter.js";
import { ADAPTER_NAME } from "./lib/thread-id.js";
import type { ZaloOaAdapterConfig } from "./types.js";

const ENV_VARS = {
  appId: "ZALO_OA_APP_ID",
  appSecret: "ZALO_OA_APP_SECRET",
  oaSecretKey: "ZALO_OA_SECRET_KEY",
  oaId: "ZALO_OA_ID",
  accessToken: "ZALO_OA_ACCESS_TOKEN",
  refreshToken: "ZALO_OA_REFRESH_TOKEN",
} as const;

/**
 * Create a Zalo OA adapter, falling back to environment variables.
 *
 * Every credential is required: a missing one would otherwise surface much
 * later as an opaque API rejection, or — for the OA secret key — as every
 * webhook failing verification.
 */
export function createZaloOaAdapter(
  config?: Partial<ZaloOaAdapterConfig> & { fetchImpl?: typeof fetch },
): ZaloOaAdapter {
  const resolved = {} as Record<keyof typeof ENV_VARS, string>;

  for (const [key, envVar] of Object.entries(ENV_VARS) as Array<[keyof typeof ENV_VARS, string]>) {
    const value = config?.[key] ?? process.env[envVar];
    if (!value) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Zalo OA ${key} is required. Pass it in config or set ${envVar}.`,
      );
    }
    resolved[key] = value;
  }

  return new ZaloOaAdapter({ ...config, ...resolved });
}

/** Shorthand for {@link createZaloOaAdapter}. */
export const zaloOa = createZaloOaAdapter;
