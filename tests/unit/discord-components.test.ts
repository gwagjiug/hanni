import { describe, expect, it } from "vitest";
import { componentValue, editModal } from "../../src/tools/discord";
import type { ArchiveDraft } from "../../src/types";

describe("Discord modal values", () => {
  it("reads legacy action-row modal responses", () => {
    expect(componentValue({ components: [{ components: [{ custom_id: "pins", value: "one" }] }] }, "pins")).toBe("one");
  });

  it("reads label-wrapped component responses", () => {
    expect(componentValue({ components: [{ component: { custom_id: "pins", value: "two" } }] }, "pins")).toBe("two");
  });

  it("renders the edit form with Discord-compatible text input limits", async () => {
    const draft = {
      runId: "run",
      title: "제목",
      category: { name: "AI", mode: "existing", rationale: "fit" },
      slug: "title",
      pins: ["pin"],
      prTitle: "제목",
      prBody: "본문",
    } as ArchiveDraft;
    const body = await editModal(draft).json() as {
      data: { components: Array<{ type: number; components: Array<{ max_length: number }> }> };
    };
    expect(body.data.components).toHaveLength(5);
    expect(body.data.components.every((row) => row.type === 1)).toBe(true);
    expect(body.data.components.every((row) => row.components[0]!.max_length <= 4000)).toBe(true);
  });
});
