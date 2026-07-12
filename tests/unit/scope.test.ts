import { describe, expect, it } from "vitest";
import { isAuthorized, normalizePublicUrl } from "../../src/policies/scope";

describe("scope policy", () => {
  it("normalizes public URLs and removes tracking parameters", () => {
    expect(normalizePublicUrl("HTTPS://Example.COM/post?utm_source=x&id=1#part")).toBe("https://example.com/post?id=1");
  });

  it.each([
    "된장찌개 레시피 알려줘",
    "file:///etc/passwd",
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.0.1/",
  ])("rejects out-of-scope or private input: %s", (input) => {
    expect(() => normalizePublicUrl(input)).toThrow();
  });

  it("requires the exact configured guild, channel and owner", () => {
    const expected = { guildId: "g", channelId: "c", userId: "u" };
    expect(isAuthorized({ guildId: "g", channelId: "c", userId: "u" }, expected)).toBe(true);
    expect(isAuthorized({ guildId: "g", channelId: "c", userId: "other" }, expected)).toBe(false);
  });
});
