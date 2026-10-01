/**
 * Vitest harness for pw-tools-core modules that need mocked Playwright session
 * state and download capture.
 */
import { beforeEach, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
type HarnessManagedDownload = {
  url: string;
  suggestedFilename: string;
  path: string;
};
type HarnessDownloadCapture = {
  armed: boolean;
  promise: Promise<HarnessManagedDownload>;
  cancel: ReturnType<typeof vi.fn>;
};
let currentDownloadCapture: HarnessDownloadCapture | undefined;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
} = {
  console: [],
  armIdUpload: 0,
  armIdDownload: 0,
  downloadWaiterDepth: 0,
};

const sessionMocks = vi.hoisted(() => ({
  beginActionDownloadCaptureOnPage: vi.fn(() => ({
    drain: vi.fn(async (): Promise<HarnessManagedDownload[] | undefined> => undefined),
    dispose: vi.fn(() => {}),
  })),
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) {
      throw new Error("missing page");
    }
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  // Match by name so mocked errors are recognized without importing real classes.
  isDownloadStartingNavigationError: vi.fn((err: unknown, expectedUrl?: string) => {
    if (!(err instanceof Error)) {
      return false;
    }
    const message = err.message.toLowerCase();
    if (message.includes("download is starting")) {
      return true;
    }
    const normalizedUrl = expectedUrl?.trim().toLowerCase();
    return Boolean(
      normalizedUrl && message.includes("net::err_aborted") && message.includes(normalizedUrl),
    );
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  respondToObservedDialogOnPage: vi.fn(async () => {
    throw new Error("No dialog is pending.");
  }),
  armObservedDialogResponseOnPage: vi.fn(() => {}),
  createObservedDialogAbortSignalForPage: vi.fn((opts?: { parentSignal?: AbortSignal }) => ({
    signal: opts?.parentSignal ?? new AbortController().signal,
    cleanup: vi.fn(() => {}),
  })),
  isBrowserObservedDialogBlockedError: vi.fn(() => false),
  storeRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) {
      throw new Error("missing locator");
    }
    return currentRefLocator;
  }),
}));

const downloadCaptureMocks = vi.hoisted(() => ({
  createDownloadCaptureForPage: vi.fn(),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./pw-download-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pw-download-capture.js")>();
  downloadCaptureMocks.createDownloadCaptureForPage.mockImplementation(
    (page, state, timeoutMs, opts) =>
      currentDownloadCapture ?? actual.createDownloadCaptureForPage(page, state, timeoutMs, opts),
  );
  return {
    ...actual,
    createDownloadCaptureForPage: downloadCaptureMocks.createDownloadCaptureForPage,
  };
});

/** Returns mocked pw-session exports shared by pw-tools-core tests. */
export function getPwToolsCoreSessionMocks() {
  return sessionMocks;
}

/** Sets the current mocked page returned by getPageForTargetId. */
export function setPwToolsCoreCurrentPage(page: Record<string, unknown> | null) {
  if (page) {
    const context = {};
    const mainFrame = {};
    page.context ??= vi.fn(() => context);
    page.mainFrame ??= vi.fn(() => mainFrame);
    page.isClosed ??= vi.fn(() => false);
    page.on ??= vi.fn();
    page.off ??= vi.fn();
    page.url ??= vi.fn(() => "about:blank");
    page.viewportSize ??= vi.fn(() => null);
  }
  currentPage = page;
}

/** Sets the current mocked locator returned by refLocator. */
export function setPwToolsCoreCurrentRefLocator(locator: Record<string, unknown> | null) {
  currentRefLocator = locator;
}

export function setPwToolsCoreDownloadCapture(capture: HarnessDownloadCapture | undefined) {
  currentDownloadCapture = capture;
}

/** Installs per-test cleanup for pw-tools-core mocked session state. */
export function installPwToolsCoreTestHooks() {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    currentDownloadCapture = undefined;
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    };

    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(downloadCaptureMocks)) {
      fn.mockClear();
    }
  });
}
