const ACTIVE_PROGRESS_STATUS_SQL =
  "'RECEIVED', 'VALIDATING', 'ANALYZING', 'AWAITING_APPROVAL', 'CREATING_PR'";

export class RunProgressStore {
  constructor(private readonly db: D1Database) {}

  async progress(
    id: string,
    step: string,
    detail: string,
    retryCount = 0,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const [updateResult] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE runs SET current_step = ?, step_started_at = ?, last_heartbeat_at = ?,
           retry_count = ?, updated_at = ?
           WHERE id = ? AND status IN (${ACTIVE_PROGRESS_STATUS_SQL})`,
        )
        .bind(step, now, now, retryCount, now, id),
      this.db
        .prepare(
          `INSERT INTO run_events (run_id, event_type, step, status, detail, created_at)
           SELECT id, 'STEP_STARTED', ?, status, ?, ? FROM runs
           WHERE id = ? AND status IN (${ACTIVE_PROGRESS_STATUS_SQL})`,
        )
        .bind(step, detail.slice(0, 300), now, id),
    ]);
    if (!updateResult || updateResult.meta.changes !== 1) {
      return false;
    }
    console.log({
      event: 'hanni.step.started',
      runId: id,
      step,
      retryCount,
    });
    return true;
  }
}
