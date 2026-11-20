import { DatabaseSync } from "node:sqlite";
import type { MediaOperationStorage } from "../../src/media-operation-storage.js";

/**
 * A real node:sqlite database behind the Workers-shaped synchronous SQL
 * capability Darkroom's owners use. It lives in Darkroom so the tests run from
 * the published package as well as from the repository.
 */
export function createNativeSqliteFixture(databasePath = ":memory:") {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  const storage: Pick<MediaOperationStorage, "sql" | "transactionSync"> = {
    sql: {
      exec: (statement, ...bindings) => {
        const prepared = database.prepare(statement);
        const rows = /^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(statement)
          ? prepared.all(...bindings).map((row) => ({ ...row }))
          : (prepared.run(...bindings), []);
        return { toArray: () => rows };
      },
    },
    transactionSync: (body) => {
      database.exec("BEGIN");
      try {
        const result = body();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    storage,
    close: () => {
      database.close();
    },
  };
}
