// Regenerates the committed golden `.fd4cfg` fixture and its field-by-field
// import snapshot. The fixture is fully synthetic — real recovered coder keys,
// fake values only — so it can live in the repository.
//
//   node --experimental-strip-types tools/build-golden-fixture.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildLegacyArchive } from "../app/fd4cfg-export.ts";
import { parseLegacyFd4Config } from "../app/fd4cfg.ts";
import { buildGoldenAppData } from "../tests/golden-app-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "..", "tests", "fixtures");
await mkdir(fixtureDir, { recursive: true });

const bytes = buildLegacyArchive(buildGoldenAppData());
await writeFile(path.join(fixtureDir, "golden.fd4cfg"), bytes);

const imported = parseLegacyFd4Config(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);
await writeFile(
  path.join(fixtureDir, "golden-import.json"),
  JSON.stringify(imported, null, 2) + "\n",
);
console.log(
  `golden.fd4cfg: ${bytes.length} bytes;`,
  `snapshot: ${imported.rooms.length} rooms, ${imported.channels.length} channels,`,
  `${imported.switches.length} switches, ${imported.scenes.length} scenes,`,
  `${imported.periods.length} periods, ${imported.users.length} users`,
);
