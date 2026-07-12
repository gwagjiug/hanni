import { isAllowedHostname, normalizePublicUrl } from "../../policies/scope";

export interface WebMetadata {
  title: string | null;
  canonicalUrl: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

export async function fetchMetadata(inputUrl: string, fetcher: typeof fetch = fetch): Promise<WebMetadata> {
  let current = normalizePublicUrl(inputUrl);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetcher(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "Hanni/0.1 (+https://github.com/gwagjiug/hanni)", accept: "text/html" },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("unsafe_or_excessive_redirect");
      const next = new URL(location, current);
      if (!isAllowedHostname(next.hostname)) throw new Error("blocked_redirect_target");
      current = normalizePublicUrl(next.toString());
      continue;
    }
    if (!response.ok) throw new Error(`metadata_http_${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return { title: null, canonicalUrl: current };
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 1_000_000) throw new Error("metadata_response_too_large");
    const html = (await response.text()).slice(0, 1_000_000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const canonicalMatch = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i)
      ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i);
    let canonicalUrl = current;
    if (canonicalMatch?.[1]) {
      const candidate = new URL(canonicalMatch[1], current);
      if (isAllowedHostname(candidate.hostname)) canonicalUrl = normalizePublicUrl(candidate.toString());
    }
    return { title: titleMatch?.[1] ? decodeHtml(titleMatch[1]) : null, canonicalUrl };
  }
  throw new Error("metadata_unreachable");
}
