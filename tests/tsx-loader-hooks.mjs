// The resolve/load hooks behind tsx-loader.mjs.
//
// Only .ts/.tsx under this project are transformed; everything else is left to
// Node. The resolve hook also fills in the extension for the bundler-style
// extensionless relative imports the page component uses (`./fd4cfg`), which
// Node's ESM resolver rejects on its own.

import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const TS_PATTERN = /\.tsx?$/;

const exists = (url) =>
  access(fileURLToPath(url)).then(
    () => true,
    () => false,
  );

export async function resolve(specifier, context, nextResolve) {
  // Only relative/absolute specifiers can be extensionless source files.
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const url = new URL(base.href + candidate);
        if (await exists(url)) return { url: url.href, shortCircuit: true };
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !TS_PATTERN.test(new URL(url).pathname))
    return nextLoad(url, context);

  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const { code } = await transform(source, {
    loader: path.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    sourcefile: path,
    // The page is a client component; the directive is meaningless here and
    // esbuild warns about it otherwise.
    supported: { "using": false },
  });
  return { format: "module", source: code, shortCircuit: true };
}
