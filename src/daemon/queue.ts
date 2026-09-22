// Brain concurrency: at most `global` children overall and one per session.
// Turns of one session run in order; a newer prompt never cancels an older
// analysis. cancelAll() is for daemon shutdown only.
export interface Job {
  turn_id: string;
  session_id: string;
  run: (signal: AbortSignal) => Promise<void>;
}

export class BrainQueue {
  private running = new Map<string, { turn_id: string; ctrl: AbortController }>(); // session -> job
  private waiting: Job[] = [];
  constructor(private globalLimit = 2) {}

  get active(): number {
    return this.running.size;
  }

  push(job: Job): void {
    this.waiting.push(job);
    this.pump();
  }

  cancelAll(): void {
    this.waiting = [];
    for (const r of this.running.values()) r.ctrl.abort();
    this.running.clear();
  }

  private pump(): void {
    while (this.running.size < this.globalLimit) {
      const idx = this.waiting.findIndex((j) => !this.running.has(j.session_id));
      if (idx < 0) return;
      const job = this.waiting.splice(idx, 1)[0];
      const ctrl = new AbortController();
      this.running.set(job.session_id, { turn_id: job.turn_id, ctrl });
      job
        .run(ctrl.signal)
        .catch(() => undefined)
        .finally(() => {
          const cur = this.running.get(job.session_id);
          if (cur && cur.turn_id === job.turn_id) this.running.delete(job.session_id);
          this.pump();
        });
    }
  }
}
