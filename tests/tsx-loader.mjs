// Node module customization hook that compiles .tsx/.ts for tests.
//
// Node's built-in type stripping handles .ts but cannot strip JSX, so the page
// component cannot be imported without a transform. esbuild is already present
// (vite depends on it) and does this in a single synchronous call.
//
// Registered via `node --import ./tests/tsx-loader.mjs`.

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsx-loader-hooks.mjs", pathToFileURL(import.meta.filename));
