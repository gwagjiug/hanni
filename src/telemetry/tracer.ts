import type { Env } from "../types";

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

function redact(attributes: SpanAttributes): SpanAttributes {
  const safe: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (/pin|url|prompt|response|token|secret|key/i.test(key) && !/(input_tokens|output_tokens|cached_tokens|pin_count)/i.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

export class Tracer {
  constructor(
    private readonly env: Env,
    private readonly runId: string,
    private readonly defer: (promise: Promise<unknown>) => void = (promise) => {
      void promise;
    },
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async span<T>(name: string, attributes: SpanAttributes, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let status = "OK";
    try {
      return await work();
    } catch (error) {
      status = "ERROR";
      throw error;
    } finally {
      this.defer(this.export({ name, started, ended: Date.now(), status, attributes: redact({ ...attributes, "hanni.run_id": this.runId }) }));
    }
  }

  private async export(span: unknown): Promise<void> {
    if (!this.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.env.OTEL_EXPORTER_OTLP_HEADERS) headers.authorization = this.env.OTEL_EXPORTER_OTLP_HEADERS;
    const item = span as { name: string; started: number; ended: number; status: string; attributes: SpanAttributes };
    const traceId = this.runId.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
    const spanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const attributes = Object.entries(item.attributes).flatMap(([key, value]) => {
      if (value === undefined) return [];
      const typed = typeof value === "number"
        ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value })
        : typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) };
      return [{ key, value: typed }];
    });
    const payload = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "hanni" } }] },
        scopeSpans: [{
          scope: { name: "hanni", version: "0.1.0" },
          spans: [{
            traceId,
            spanId,
            name: item.name,
            kind: 1,
            startTimeUnixNano: String(item.started * 1_000_000),
            endTimeUnixNano: String(item.ended * 1_000_000),
            attributes,
            status: { code: item.status === "OK" ? 1 : 2 },
          }],
        }],
      }],
    };
    await this.fetcher(this.env.OTEL_EXPORTER_OTLP_ENDPOINT, { method: "POST", headers, body: JSON.stringify(payload) }).then(() => undefined).catch(() => undefined);
  }
}
