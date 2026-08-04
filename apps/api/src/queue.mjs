/**
 * In-process job queue for APK builds (§D4).
 *
 * Production wants BullMQ + Redis so builds survive a restart and scale across
 * workers. This is the same interface at a smaller scale: bounded concurrency,
 * per-stage status, idempotency, and an event stream the UI can subscribe to.
 * Swapping in BullMQ means reimplementing `enqueue`/`get`/`subscribe`, nothing else.
 *
 * Concurrency default is 2: an APK build peaks around 1.5 GB of JVM heap across
 * javac/d8/aapt2, so more parallelism on a small box just causes thrashing.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const STAGES = [
  'queued', 'preparing', 'patching', 'compiling', 'packaging', 'signing', 'verifying', 'ready',
];

export class BuildQueue extends EventEmitter {
  constructor({ concurrency = Number(process.env.BUILD_CONCURRENCY || 2) } = {}) {
    super();
    this.concurrency = concurrency;
    this.jobs = new Map();      // buildId -> job
    this.byKey = new Map();     // idempotency key -> buildId
    this.pending = [];
    this.running = 0;
  }

  /**
   * @param {string} key idempotency key, e.g. `${gameId}:v${version}:android`
   * @param {object} payload
   * @param {(job:object, setStage:(s:string,d?:string)=>void)=>Promise<object>} worker
   */
  enqueue(key, payload, worker) {
    const existing = this.byKey.get(key);
    if (existing) {
      const job = this.jobs.get(existing);
      // only reuse a job that succeeded or is still in flight; retry failures
      if (job && job.status !== 'failed') return job;
    }

    const id = randomUUID();
    const job = {
      id,
      key,
      status: 'queued',
      stage: 'queued',
      detail: null,
      payload,
      result: null,
      error: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      log: [],
    };
    this.jobs.set(id, job);
    this.byKey.set(key, id);
    this.pending.push({ job, worker });
    this.emit('update', job);
    setImmediate(() => this.#drain());
    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1));
  }

  #setStage(job, stage, detail) {
    job.stage = stage;
    job.detail = detail ?? null;
    job.log.push({ stage, detail: detail ?? null, at: new Date().toISOString() });
    this.emit('update', job);
  }

  async #drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const { job, worker } = this.pending.shift();
      this.running++;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      const t0 = Date.now();
      this.emit('update', job);

      worker(job, (stage, detail) => this.#setStage(job, stage, detail))
        .then((result) => {
          job.result = result;
          job.status = 'ready';
          this.#setStage(job, 'ready');
        })
        .catch((err) => {
          job.status = 'failed';
          job.error = String(err && err.message ? err.message : err);
          this.#setStage(job, 'failed', job.error);
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          job.durationMs = Date.now() - t0;
          this.running--;
          this.emit('update', job);
          this.#drain();
        });
    }
  }
}

export const buildQueue = new BuildQueue();
