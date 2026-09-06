# Apps

Applications that exercise Kandelo as a product surface live here.

- `browser-demos/` is the Vite app for the Kandelo web UI and retained browser labs. It consumes the browser host runtime from `host/src/browser-kernel-host.ts`; host/runtime code should not live under the app tree.
- `signalling/` is a signalling server for connecting two Kandelo computers: one self-modifying PHP file that carries the invite and answer codes between them by session name. The browser client in `browser-demos/lib/peer-signalling.ts` drives it when the page is opened with `?signalling=<url>` or built with `VITE_SIGNALLING_URL`.

Reusable session contracts and browser-independent integration code belong in
`web-libs/`, not inside an app directory.
