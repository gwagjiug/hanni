import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/storage/runs";

function database(changes = 1): {
  db: D1Database;
  statements: string[];
} {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() {
          return this;
        },
        async run() {
          return { meta: { changes } };
        },
      };
    },
  } as unknown as D1Database;
  return { db, statements };
}

describe("RunStore terminal-state privacy", () => {
  it("removes user content and interaction credentials on cancellation", async () => {
    const { db, statements } = database();
    expect(await new RunStore(db).cancel("run")).toBe(true);
    expect(statements[0]).toContain("interaction_token = NULL");
    expect(statements[0]).toContain("source_url = NULL");
    expect(statements[0]).toContain("draft_json = NULL");
  });

  it("removes user content and interaction credentials on failure", async () => {
    const { db, statements } = database();
    await new RunStore(db).fail("run", "ANALYZING", "FAILED_EXTERNAL", "test");
    expect(statements[0]).toContain("interaction_token = NULL");
    expect(statements[0]).toContain("source_url = NULL");
    expect(statements[0]).toContain("draft_json = NULL");
  });
});
