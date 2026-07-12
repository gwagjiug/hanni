function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1").replace(/\r?\n/g, " ");
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "archive-entry";
}

export async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 4).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function renderPinFile(title: string, url: string, pins: string[]): string {
  const blocks = pins.map((pin) => pin.split("\n").map((line) => `> ${line}`).join("\n")).join("\n\n");
  return `# ${title}\n\n[원문](${url})\n\n## Pins\n\n${blocks}\n`;
}

export function archiveEntry(title: string, url: string, slug: string): string {
  return `- [${escapeMarkdownLabel(title)}](${url}) ([pins](pins/${slug}.md))`;
}

export function insertReadmeEntry(readme: string, category: string, entry: string): string {
  if (readme.includes(entry)) return readme;
  const heading = `## ${category}`;
  const start = readme.indexOf(heading);
  if (start < 0) return `${readme.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  const nextHeading = readme.indexOf("\n## ", start + heading.length);
  const end = nextHeading < 0 ? readme.length : nextHeading;
  const section = readme.slice(start, end).trimEnd();
  return `${readme.slice(0, start)}${section}\n${entry}\n\n${readme.slice(end).replace(/^\n+/, "")}`;
}

export function hasUrl(readme: string, normalizedUrl: string): boolean {
  const target = new URL(normalizedUrl);
  target.hash = "";
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"])
    target.searchParams.delete(key);
  for (const match of readme.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
    try {
      const found = new URL(match[1]!);
      found.hash = "";
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"])
        found.searchParams.delete(key);
      if (found.toString() === target.toString()) return true;
    } catch {
      // Existing malformed README links do not block a valid new entry.
    }
  }
  return false;
}

export function extractCategories(readme: string): string[] {
  return [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]!.trim());
}
