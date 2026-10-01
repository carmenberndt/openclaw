/** URL syntax and scheme validation for explicit browser page navigation. */
const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
const BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE =
  "Navigation blocked: URL-embedded credentials are not supported for page navigation. Set HTTP Basic auth with `openclaw browser set credentials <username> <password>` or use an authenticated browser profile.";

/** Raised when a browser navigation URL fails syntax or scheme validation. */
export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

/** Parse a page-navigation URL and reject credentials before any transport dispatch. */
export function parseBrowserNavigationUrl(url: string): URL {
  const rawUrl = url.trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  const parsed = URL.parse(rawUrl);
  if (!parsed) {
    const diagnostic = rawUrl.includes("@") ? "[redacted credential-bearing URL]" : rawUrl;
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${diagnostic}`);
  }

  if (parsed.username || parsed.password) {
    throw new InvalidBrowserNavigationUrlError(BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE);
  }
  if (
    !NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) &&
    !SAFE_NON_NETWORK_URLS.has(parsed.href)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }
  return parsed;
}
