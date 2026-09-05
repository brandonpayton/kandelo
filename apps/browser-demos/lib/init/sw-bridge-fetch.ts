/**
 * Wire a service-worker HTTP bridge to BrowserKernel.fetchInKernel.
 *
 * The service-worker bridge gives us an `HttpBridgeHost` whose `onRequest`
 * fires whenever the SW intercepts an in-kernel app fetch. Each such
 * request gets forwarded to `kernel.fetchInKernel(port, ...)` and the
 * resulting response is sent back through the bridge.
 *
 * Replaces the older pattern that transferred the bridge's MessagePort to
 * the kernel worker via `kernel.sendBridgePort`. The new pattern keeps the
 * bridge entirely on the main thread; the kernel worker no longer needs a
 * special direct port.
 */
import type { BrowserKernel } from "@host/browser-kernel-host";
import { HttpBridgeHost, type HttpRequest } from "../http-bridge";
import { initServiceWorkerBridge } from "./service-worker-bridge";

interface ServiceWorkerFetchBridgeOptions {
  timeoutMs?: number;
  debugLog?: (line: string) => void;
  onPendingRequests?: (count: number) => void;
}

let activeNeedBridgeListener: ((event: MessageEvent) => void) | null = null;

/** Hook a single bridge instance up to fetchInKernel. */
export function attachBridgeToKernel(
  bridge: HttpBridgeHost,
  kernel: BrowserKernel,
  port: number,
  options?: ServiceWorkerFetchBridgeOptions,
): void {
  let pendingRequests = 0;
  const updatePendingRequests = (delta: 1 | -1) => {
    pendingRequests = Math.max(0, pendingRequests + delta);
    options?.onPendingRequests?.(pendingRequests);
  };

  bridge.onRequest(async (requestId, request: HttpRequest) => {
    updatePendingRequests(1);
    try {
      const response = await kernel.fetchInKernel(port, request, {
        timeoutMs: options?.timeoutMs,
      });
      bridge.respond(requestId, response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      options?.debugLog?.(`bridge fetch failed: ${request.method} ${request.url}: ${msg}`);
      bridge.error(requestId, msg);
    } finally {
      updatePendingRequests(-1);
    }
  });
}

/**
 * Set up a service-worker HTTP bridge whose requests are routed to
 * `kernel.fetchInKernel(port, ...)`. Returns the bridge so callers can
 * track readiness or tear down.
 *
 * Also installs a `need-bridge` listener for service-worker restarts: when
 * the SW reincarnates and asks for a fresh bridge, we hand it a new
 * `HttpBridgeHost` already wired to `fetchInKernel` so the iframe keeps
 * working without a kernel restart.
 *
 * `sessionId` uniquely identifies this Kandelo machine instance and scopes the
 * SW cookie jar to it, so cookies are never shared between sessions. It is sent
 * on both the initial handshake and the restart handshake so the SW reloads the
 * same session's jar after it is terminated. This page keeps `sessionId` in
 * memory for its whole lifetime, so it is stable across SW restarts but fresh on
 * a full reload (a new temporary session).
 */
export async function setupServiceWorkerFetchBridge(
  swUrl: string,
  scopePath: string,
  appPrefix: string,
  kernel: BrowserKernel,
  port: number,
  sessionId: string,
  options?: ServiceWorkerFetchBridgeOptions,
): Promise<HttpBridgeHost> {
  const bridge = await initServiceWorkerBridge(
    swUrl,
    scopePath,
    appPrefix,
    sessionId,
  );
  if (!bridge) {
    throw new Error("Service workers unavailable — HTTP bridge not initialized");
  }
  attachBridgeToKernel(bridge, kernel, port, options);

  if ("serviceWorker" in navigator) {
    // One listener per page, wired to the newest machine. A page boots one
    // machine at a time but boots more than one over its lifetime (a demo
    // relaunch, a takeover), and a listener left behind by a retired machine
    // would answer the restart handshake with a port wired to a destroyed
    // kernel.
    if (activeNeedBridgeListener) {
      navigator.serviceWorker.removeEventListener(
        "message",
        activeNeedBridgeListener,
      );
    }
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "need-bridge") return;
      const replyPort = event.ports[0];
      if (!replyPort) return;
      const fresh = new HttpBridgeHost();
      attachBridgeToKernel(fresh, kernel, port, options);
      replyPort.postMessage(
        { type: "bridge-restored", appPrefix, sessionId },
        [fresh.getSwPort()],
      );
      options?.debugLog?.("Bridge restored after service worker restart");
    };
    activeNeedBridgeListener = listener;
    navigator.serviceWorker.addEventListener("message", listener);
  }

  return bridge;
}
