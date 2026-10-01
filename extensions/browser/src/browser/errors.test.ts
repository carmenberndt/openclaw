// Browser tests cover errors plugin behavior.
import { describe, expect, it } from "vitest";
import {
  BROWSER_ACT_ERROR_CODES,
  BROWSER_ERROR_REASONS,
  BrowserProfileUnavailableError,
  BrowserActionError,
  BrowserNativePolicyBlockedError,
  BrowserTabNotFoundError,
  parseBrowserErrorPayload,
  toBrowserErrorResponse,
} from "./errors.js";

describe("browser action errors", () => {
  it("preserves known codes and drops unknown route metadata", () => {
    expect(
      parseBrowserErrorPayload({
        error: "evaluation disabled",
        code: BROWSER_ACT_ERROR_CODES.evaluateDisabled,
        untrusted: "drop me",
      }),
    ).toEqual({
      error: "evaluation disabled",
      code: BROWSER_ACT_ERROR_CODES.evaluateDisabled,
    });
    expect(parseBrowserErrorPayload({ error: "failure", code: "UNTRUSTED_CODE" })).toEqual({
      error: "failure",
      unrecognizedCode: true,
    });
  });

  it("preserves the navigation reason without forwarding policy details", () => {
    expect(
      parseBrowserErrorPayload({
        error: "browser navigation blocked by policy",
        reason: "navigation_blocked",
        details: { url: "http://internal.example/admin", address: "10.0.0.1" },
        cause: "private lookup details",
      }),
    ).toEqual({
      error: "browser navigation blocked by policy",
      reason: "navigation_blocked",
    });
    expect(
      parseBrowserErrorPayload({ error: "failure", reason: "untrusted_reason", details: {} }),
    ).toEqual({ error: "failure" });
  });
});

describe("native enterprise policy errors", () => {
  it("reports a denial established by the native navigation owner", () => {
    const result = toBrowserErrorResponse(new BrowserNativePolicyBlockedError("navigation"));
    expect(result).toMatchObject({ status: 403, reason: "native_policy_blocked" });
    expect(result?.message).toContain("openclaw browser policy");
    expect(
      parseBrowserErrorPayload({
        error: result?.message,
        reason: result && "reason" in result ? result.reason : undefined,
      }),
    ).toMatchObject({ reason: "native_policy_blocked" });
  });

  it("gives administrator guidance when policy disables browser control", () => {
    const result = toBrowserErrorResponse(new BrowserNativePolicyBlockedError("remote-debugging"));
    expect(result).toMatchObject({ status: 403, reason: "native_policy_blocked" });
    expect(result?.message).toContain("RemoteDebuggingAllowed");
  });

  it("does not mislabel unrelated network failures", () => {
    expect(toBrowserErrorResponse(new Error("page.goto: net::ERR_CONNECTION_REFUSED"))).toBeNull();
    expect(toBrowserErrorResponse(new Error("Access denied"))).toBeNull();
  });

  it.each([
    "net::ERR_BLOCKED_BY_ADMINISTRATOR",
    "DevTools remote debugging is disallowed by the system admin.",
  ])("preserves an evaluate failure quoting %s", (diagnostic) => {
    const message = `page.evaluate: Error: Invalid evaluate function: ${diagnostic}`;
    expect(toBrowserErrorResponse(new Error(message))).toBeNull();
    expect(toBrowserErrorResponse(new BrowserActionError(message))).toMatchObject({
      message,
      code: BROWSER_ACT_ERROR_CODES.operationFailed,
    });
  });
});

describe("BrowserTabNotFoundError", () => {
  it("teaches agents that bare numbers are not stable tab targets", () => {
    const err = new BrowserTabNotFoundError({ input: "2" });

    expect(err.message).toBe(
      'tab not found: browser tab "2" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select 2".',
    );
  });
});

describe("no-display browser errors", () => {
  const details = {
    profile: "openclaw",
    requestedHeadless: false,
    headlessSource: "profile",
    displayPresent: false,
  } as const;

  it("maps a closed reason and typed details", () => {
    expect(
      toBrowserErrorResponse(
        new BrowserProfileUnavailableError("display required", {
          metadata: {
            reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
            details,
          },
        }),
      ),
    ).toEqual({
      status: 409,
      message: "display required",
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details,
    });
  });

  it("accepts only valid no-display metadata from route payloads", () => {
    const payload = {
      error: "display required",
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details,
    };
    expect(parseBrowserErrorPayload(payload)).toEqual({
      error: "display required",
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details,
    });
    expect(
      parseBrowserErrorPayload({
        ...payload,
        details: { ...details, requestedHeadless: true, remediation: "untrusted" },
      }),
    ).toEqual({ error: "display required" });
  });
});
