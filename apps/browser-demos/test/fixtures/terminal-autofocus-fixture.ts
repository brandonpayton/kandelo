import * as React from "react";
import * as ReactDOM from "react-dom/client";

import { KernelHostProvider } from "../../pages/kandelo/kernel-host/react";
import { Shell } from "../../pages/kandelo/panes/Shell";
import type {
  KernelHost,
  PtyHandle,
} from "../../../../web-libs/kandelo-session/src/kernel-host";

export interface DelayedPtyShellFixture {
  resolveAttach(): void;
  unmount(): void;
  waitForAttachRequest(): Promise<void>;
}

export function mountDelayedPtyShell(
  container: HTMLElement,
): DelayedPtyShellFixture {
  let resolveAttachRequest!: () => void;
  let resolvePty!: (pty: PtyHandle) => void;
  const attachRequest = new Promise<void>((resolve) => {
    resolveAttachRequest = resolve;
  });
  const attachedPty = new Promise<PtyHandle>((resolve) => {
    resolvePty = resolve;
  });
  const pty: PtyHandle = {
    close() {},
    onData: () => () => {},
    resize() {},
    size: () => ({ cols: 80, rows: 24 }),
    write() {},
  };
  const host = {
    attachPty: () => {
      resolveAttachRequest();
      return attachedPty;
    },
    getStatus: () => "running",
    subscribeStatus: () => () => {},
  } as unknown as KernelHost;

  const root = ReactDOM.createRoot(container);
  root.render(
    React.createElement(
      KernelHostProvider,
      { host },
      React.createElement(Shell, { autoFocus: true }),
    ),
  );

  return {
    resolveAttach: () => resolvePty(pty),
    unmount: () => root.unmount(),
    waitForAttachRequest: () => attachRequest,
  };
}
