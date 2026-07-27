import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * PWA asset checks that are meaningful without a device.
 *
 * What CANNOT be verified here, and is therefore left unchecked in TODO.md:
 * installed-app launch, real offline behaviour, iOS touch handling and iPad
 * landscape layout. Those need an actual iPad running the installed PWA; a
 * headless fetch of the manifest proves none of them.
 */

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the manifest is valid JSON with the fields iOS installation needs", async () => {
  const manifest = JSON.parse(await read("public/manifest.webmanifest"));
  assert.equal(typeof manifest.name, "string");
  assert.equal(typeof manifest.short_name, "string");
  assert.equal(manifest.start_url, "/");
  // standalone is what removes Safari's chrome on an installed launch.
  assert.equal(manifest.display, "standalone");
  // The app is a landscape control surface on a wall-mounted iPad.
  assert.equal(manifest.orientation, "landscape");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\//, "icon paths must be absolute");
    assert.match(icon.sizes, /^\d+x\d+$/);
    assert.equal(typeof icon.type, "string");
  }
});

test("every manifest icon actually exists in the served assets", async () => {
  const manifest = JSON.parse(await read("public/manifest.webmanifest"));
  for (const icon of manifest.icons) {
    // A manifest naming a missing icon installs with a blank home-screen tile,
    // which only shows up on a device unless it is checked here.
    const file = await readFile(
      new URL(`../public${icon.src}`, import.meta.url),
    ).catch(() => null);
    assert.ok(file, `manifest icon ${icon.src} is missing from public/`);
    assert.ok(file.length > 0, `manifest icon ${icon.src} is empty`);
  }
});

test("the layout links the manifest and sets a viewport that covers the notch", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /manifest: "\/manifest\.webmanifest"/);
  // viewportFit: cover is what lets a landscape iPad layout reach the edges.
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(layout, /width: "device-width"/);
});

test("the service worker retires itself instead of caching the app shell", async () => {
  const worker = await read("public/sw.js");
  // Deliberate: a cached client bundle can send obsolete connection fields to a
  // rebuilt bridge. The worker unregisters and clears its old caches.
  assert.match(worker, /self\.registration\.unregister\(\)/);
  assert.match(worker, /caches\.delete/);
  assert.match(worker, /skipWaiting/);
  // It must not install a fetch handler; that is what would serve stale assets.
  assert.equal(
    /addEventListener\(\s*["']fetch["']/.test(worker),
    false,
    "a fetch handler would reintroduce the stale-bundle problem",
  );
});

test("the worker clears exactly the caches this app created", async () => {
  const worker = await read("public/sw.js");
  // Scoped to the app's own prefix so it cannot delete another origin's caches.
  assert.match(worker, /startsWith\("flexidim-web-"\)/);
});

test("offline reconnection is the client's job, not a cached worker's", async () => {
  // The app reconnects to the bridge over WebSocket rather than relying on a
  // worker; this pins where that responsibility lives.
  const page = await read("app/page.tsx");
  assert.match(page, /ws\.onclose/);
  assert.match(page, /Disconnected from the Scene Controller/);
});
