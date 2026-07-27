// A minimal DOM harness for driving the real page component.
//
// This exists so UI tests can assert on what a user sees and does — clicking a
// control and observing the result — instead of grepping page.tsx for label
// strings. A source-string test passes even when the control is unreachable,
// disabled, or wired to nothing.
//
// happy-dom provides the document; React renders into it for real. Browser APIs
// the page touches (storage, fetch, WebSocket) are stubbed so a test never
// reaches the network or a controller.

import { Window } from "happy-dom";

/** Installs a fresh DOM plus inert stubs for everything the page reaches for. */
export function installDom() {
  const window = new Window({ url: "http://localhost:3000/" });
  const { document } = window;

  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };

  const sockets = [];
  /** A WebSocket that connects to nothing and records what was sent. */
  class InertWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = InertWebSocket.CONNECTING;
      this.sent = [];
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    removeEventListener(type) {
      this.listeners.delete(type);
    }
    send(payload) {
      this.sent.push(payload);
    }
    close() {
      this.readyState = InertWebSocket.CLOSED;
    }
  }

  const fetchCalls = [];
  // Downloads triggered via createObjectURL + <a download>. Recorded so tests can
  // assert a file was actually produced and inspect its contents.
  const downloads = [];
  // Tests set `failFetch.value = true` to simulate the server being down.
  const failFetch = { value: false };
  const fetchStub = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    if (failFetch.value) throw new TypeError("Failed to fetch");
    // The workspace endpoint is the only one the page reads a body from.
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
      headers: new Map(),
    };
  };

  const globals = {
    window,
    document,
    navigator: window.navigator,
    localStorage: window.localStorage ?? storage,
    sessionStorage: window.sessionStorage ?? storage,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    getComputedStyle: window.getComputedStyle.bind(window),
    WebSocket: InertWebSocket,
    fetch: fetchStub,
  };

  const saved = new Map();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, {
      descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
      present: key in globalThis,
    });
    // Some globals (navigator) are getter-only on newer Node, so assignment
    // throws; defining the property replaces them cleanly either way.
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  // The page reaches these through `window` as well. happy-dom defines some of
  // them as getter-only, so they are redefined rather than assigned. happy-dom's
  // own localStorage is a real implementation, so it is left alone.
  const define = (target, key, value) =>
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
    });
  define(window, "WebSocket", InertWebSocket);
  define(window, "fetch", fetchStub);
  // Confirm dialogs must never block a test run; default to declining.
  define(window, "confirm", () => false);
  define(window, "alert", () => undefined);
  // Prompts are scripted per test: `prompts.push(answer)` queues replies, and an
  // empty queue answers null (the user cancelling).
  const prompts = [];
  define(window, "prompt", () => (prompts.length ? prompts.shift() : null));

  // Node provides its own URL.createObjectURL, so patching window.URL is not
  // enough — the app resolves the GLOBAL URL. Both are pointed at the same map.
  const objectUrls = new Map();
  let urlCounter = 0;
  const savedCreate = globalThis.URL.createObjectURL;
  const savedRevoke = globalThis.URL.revokeObjectURL;
  const URLCtor = globalThis.URL;
  URLCtor.createObjectURL = (blob) => {
    const url = `blob:mock/${(urlCounter += 1)}`;
    objectUrls.set(url, blob);
    return url;
  };
  URLCtor.revokeObjectURL = (url) => objectUrls.delete(url);
  const originalCreate = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    const element = originalCreate(tag, ...rest);
    if (String(tag).toLowerCase() === "a") {
      // The app revokes the object URL immediately after clicking, so the blob
      // must be captured synchronously; its text is read on demand.
      element.click = () => {
        const blob = objectUrls.get(element.href);
        downloads.push({
          name: element.download,
          type: blob?.type,
          blob,
          text: () => (blob ? blob.text() : Promise.resolve(undefined)),
        });
      };
    }
    return element;
  };

  return {
    window,
    document,
    downloads,
    storage,
    sockets,
    fetchCalls,
    failFetch,
    prompts,
    restore() {
      URLCtor.createObjectURL = savedCreate;
      URLCtor.revokeObjectURL = savedRevoke;
      for (const [key, previous] of saved) {
        if (previous.descriptor)
          Object.defineProperty(globalThis, key, previous.descriptor);
        else if (previous.present) delete globalThis[key];
        else delete globalThis[key];
      }
      window.happyDOM?.close?.();
    },
  };
}

/** Flush React effects and pending microtasks. */
export async function settle(times = 3) {
  for (let index = 0; index < times; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every element whose visible text matches, trimmed. */
export function byText(root, selector, text) {
  return [...root.querySelectorAll(selector)].filter((element) =>
    new RegExp(text).test((element.textContent || "").trim()),
  );
}

/** The single control with this visible label, or a clear failure. */
export function control(root, selector, text) {
  const matches = byText(root, selector, text);
  if (matches.length === 0)
    throw new Error(`no ${selector} matching ${JSON.stringify(text)}`);
  return matches[0];
}

/**
 * The input a <label> wraps, found by the label's visible text. This is how a
 * user finds a field: by reading its label, not by knowing a selector.
 */
export function fieldByLabel(root, text) {
  for (const label of root.querySelectorAll("label")) {
    if (!new RegExp(text).test((label.textContent || "").trim())) continue;
    const input = label.querySelector("input, select, textarea, output");
    if (input) return input;
  }
  throw new Error(`no field labelled ${JSON.stringify(text)}`);
}

/**
 * A `Toggle`'s button, found by the visible label text beside it. The component
 * renders an aria-pressed button inside its label rather than a checkbox.
 */
export function toggleByLabel(root, text) {
  for (const label of root.querySelectorAll("label.toggle-row")) {
    if (!new RegExp(text).test((label.textContent || "").trim())) continue;
    const button = label.querySelector("button.ios-toggle");
    if (button) return button;
  }
  throw new Error(`no toggle labelled ${JSON.stringify(text)}`);
}

/**
 * Set a form control's value the way a real keystroke does.
 *
 * React installs its own value setter on the element instance to track changes,
 * so assigning `element.value` directly is invisible to it — the DOM would show
 * the new text while React's state kept the old, and a test asserting on
 * `element.value` would pass without the app having reacted at all. Going
 * through the prototype's setter is what makes React observe the change.
 */
export function setNativeValue(element, value) {
  const prototype =
    element.tagName.toLowerCase() === "select"
      ? Object.getPrototypeOf(element).constructor.prototype
      : Object.getPrototypeOf(element).constructor.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}
