import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Add a `d1_databases` entry with binding `DB` to the Cloudflare config in vite.config.ts before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
