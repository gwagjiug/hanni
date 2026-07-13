export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

function redact(attributes: SpanAttributes): SpanAttributes {
  const safe: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      /pin|url|prompt|response|token|secret|key/i.test(key) &&
      !/(input_tokens|output_tokens|cached_tokens|pin_count)/i.test(key)
    ) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export class Tracer {
  constructor(private readonly runId: string) {}

  async span<T>(
    name: string,
    attributes: SpanAttributes,
    work: () => Promise<T>,
  ): Promise<T> {
    const { tracing } = await import('cloudflare:workers');
    return tracing.enterSpan(name, async (span) => {
      const safe = redact({ ...attributes, 'hanni.run_id': this.runId });
      for (const [key, value] of Object.entries(safe)) {
        span.setAttribute(key, value);
      }
      return work();
    });
  }
}
