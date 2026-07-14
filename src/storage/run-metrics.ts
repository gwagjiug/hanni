import { costSummarySchema, type CostSummary } from './schema';

export class RunMetricsStore {
  constructor(private readonly db: D1Database) {}

  async costSummary(userId: string): Promise<CostSummary> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) run_count,
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) completed_count,
          COALESCE(SUM(CASE WHEN status LIKE 'FAILED_%' THEN 1 ELSE 0 END), 0) failed_count,
          COALESCE(SUM(input_tokens), 0) input_tokens,
          COALESCE(SUM(output_tokens), 0) output_tokens,
          COALESCE(SUM(estimated_cost_usd), 0) estimated_cost_usd,
          COALESCE(MAX(estimated_cost_usd), 0) max_cost_usd
         FROM runs
         WHERE discord_user_id = ?
           AND created_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')`,
      )
      .bind(userId)
      .first();
    return costSummarySchema.parse(row);
  }
}
