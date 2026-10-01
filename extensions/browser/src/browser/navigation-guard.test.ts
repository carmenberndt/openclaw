import { describe, expect, it } from "vitest";
import { InvalidBrowserNavigationUrlError, parseBrowserNavigationUrl } from "./navigation-guard.js";

describe("explicit browser navigation URLs", () => {
  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "https://example.com/",
    "about:blank",
  ])("accepts %s without destination classification", (url) => {
    expect(parseBrowserNavigationUrl(url).href).toBe(url);
  });
  it.each([
    "file:///tmp/test.html",
    "javascript:alert(1)",
    "data:text/plain,test",
    "about:config",
    "ftp://example.com/",
  ])("rejects unsupported scheme in %s", (url) => {
    expect(() => parseBrowserNavigationUrl(url)).toThrow(InvalidBrowserNavigationUrlError);
  });
  it.each(["", " ", "not a URL"])("rejects invalid input %j", (url) => {
    expect(() => parseBrowserNavigationUrl(url)).toThrow(InvalidBrowserNavigationUrlError);
  });
  it.each([
    "https://secret:password@example.com/",
    "http://secret@localhost/",
    "http://secret:password@[",
  ])("redacts credentials in rejected URL %s", (url) => {
    try {
      parseBrowserNavigationUrl(url);
      throw new Error("expected URL rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("password@");
    }
  });
});
