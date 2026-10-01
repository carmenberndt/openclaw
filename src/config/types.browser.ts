import type { z } from "zod";
import type { SsrFPolicyConfig } from "./types.ssrf.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

type BrowserSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.browser>>;

export type BrowserProfileConfig = NonNullable<BrowserSchemaInput["profiles"]>[string] & {
  /** @deprecated Doctor-only legacy input; canonical schema rejects this field. */
  color?: string;
};

export type BrowserCdpPolicyConfig = SsrFPolicyConfig;

export type BrowserConfig = Omit<BrowserSchemaInput, "profiles" | "cdpPolicy"> & {
  /** @deprecated Doctor-only legacy input; canonical schema rejects this field. */
  color?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Endpoint policy for CDP control connections; does not restrict page navigation. */
  cdpPolicy?: BrowserCdpPolicyConfig;
};
