import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { bookxAnalysisJobs, type AnalysisJobDetail } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Bookkeeping for background analysis runs (casting, scene planning, sound
 * generation).
 *
 * These are much simpler than narration runs: each step is idempotent (a
 * chapter already analysed is skipped next time), so an interrupted run is
 * simply started again rather than resumed from a cursor.
 */

export type AnalysisKind = "cast" | "scenes" | "sounds";
export type AnalysisStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** A run that has not checked in for this long is treated as dead. */
const STALE_MS = 3 * 60_000;
const MAX_EVENTS = 40;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

/** Runs executing in this process. */
const localRuns = new Set<string>();

export const isAnalysisRunning = (jobId: string) => localRuns.has(jobId);

/** Analysis runs executing in this process, so the host is not stopped mid-way. */
export const analysesInProgress = (): number => localRuns.size;

function isStale(job: { status: string; heartbeatAt: Date | null; updatedAt: Date }): boolean {
  if (job.status !== "running" && job.status !== "queued") return false;
  const last = new Date(job.heartbeatAt ?? job.updatedAt).getTime();
  return Date.now() - last > STALE_MS;
}

/**
 * Returns the live run of this kind for the project, or creates one.
 *
 * Asking twice while a run is going returns the same run, which is what keeps a
 * double-click from analysing the book twice.
 */
export async function claimAnalysisJob(projectId: string, kind: AnalysisKind, message: string): Promise<{ jobId: string; reused: boolean }> {
  const db = await requireDb();
  const live = await db
    .select()
    .from(bookxAnalysisJobs)
    .where(and(eq(bookxAnalysisJobs.projectId, projectId), eq(bookxAnalysisJobs.kind, kind), inArray(bookxAnalysisJobs.status, ["queued", "running"])))
    .orderBy(desc(bookxAnalysisJobs.createdAt));

  for (const job of live) {
    if (!isStale(job) && (localRuns.has(job.id) || job.status === "queued")) return { jobId: job.id, reused: true };
    await db
      .update(bookxAnalysisJobs)
      .set({ status: "failed", message: "Interrupted. Run it again; finished work is kept.", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookxAnalysisJobs.id, job.id));
  }

  const jobId = nanoid();
  await db.insert(bookxAnalysisJobs).values({
    id: jobId,
    projectId,
    kind,
    status: "queued",
    message,
    detail: { events: [{ at: new Date().toISOString(), kind: "queued", message }] },
  });
  return { jobId, reused: false };
}

/** Progress reporting for one run. Every write doubles as a heartbeat. */
export class AnalysisReporter {
  private events: NonNullable<AnalysisJobDetail["events"]> = [];
  private errors: string[] = [];
  private summary: Record<string, number | string> = {};

  constructor(private readonly db: Db, readonly jobId: string) {}

  static async open(jobId: string): Promise<AnalysisReporter> {
    const reporter = new AnalysisReporter(await requireDb(), jobId);
    const [row] = await reporter.db.select({ detail: bookxAnalysisJobs.detail }).from(bookxAnalysisJobs).where(eq(bookxAnalysisJobs.id, jobId)).limit(1);
    reporter.events = row?.detail?.events ?? [];
    localRuns.add(jobId);
    return reporter;
  }

  private detail(): AnalysisJobDetail {
    return { events: this.events.slice(-MAX_EVENTS), errors: this.errors.slice(-MAX_EVENTS), summary: this.summary };
  }

  async start(totalSteps: number, message: string) {
    this.events.push({ at: new Date().toISOString(), kind: "started", message });
    await this.db.update(bookxAnalysisJobs).set({
      status: "running", totalSteps, completedSteps: 0, message, startedAt: new Date(), heartbeatAt: new Date(), detail: this.detail(), updatedAt: new Date(),
    }).where(eq(bookxAnalysisJobs.id, this.jobId));
  }

  async setTotal(totalSteps: number) {
    await this.db.update(bookxAnalysisJobs).set({ totalSteps, heartbeatAt: new Date(), updatedAt: new Date() }).where(eq(bookxAnalysisJobs.id, this.jobId));
  }

  async progress(completedSteps: number, message: string) {
    await this.db.update(bookxAnalysisJobs).set({ completedSteps, message: message.slice(0, 500), heartbeatAt: new Date(), updatedAt: new Date() }).where(eq(bookxAnalysisJobs.id, this.jobId));
  }

  async event(kind: string, message: string) {
    this.events.push({ at: new Date().toISOString(), kind, message: message.slice(0, 300) });
    if (kind === "warning" || kind === "error") this.errors.push(message.slice(0, 300));
    await this.db.update(bookxAnalysisJobs).set({ detail: this.detail(), heartbeatAt: new Date(), updatedAt: new Date() }).where(eq(bookxAnalysisJobs.id, this.jobId));
  }

  setSummary(values: Record<string, number | string>) {
    this.summary = { ...this.summary, ...values };
  }

  async cancelled(): Promise<boolean> {
    const [row] = await this.db.select({ cancelRequested: bookxAnalysisJobs.cancelRequested }).from(bookxAnalysisJobs).where(eq(bookxAnalysisJobs.id, this.jobId)).limit(1);
    return !row || Boolean(row.cancelRequested);
  }

  async finish(status: Exclude<AnalysisStatus, "queued" | "running">, message: string) {
    this.events.push({ at: new Date().toISOString(), kind: status, message });
    await this.db.update(bookxAnalysisJobs).set({
      status, message: message.slice(0, 500), finishedAt: new Date(), heartbeatAt: new Date(), detail: this.detail(), updatedAt: new Date(),
    }).where(eq(bookxAnalysisJobs.id, this.jobId));
    localRuns.delete(this.jobId);
  }

  release() {
    localRuns.delete(this.jobId);
  }
}

export type AnalysisProgress = {
  jobId: string | null;
  kind: AnalysisKind;
  status: AnalysisStatus | "idle";
  totalSteps: number;
  completedSteps: number;
  percent: number;
  message: string | null;
  events: NonNullable<AnalysisJobDetail["events"]>;
  errors: string[];
  summary: Record<string, number | string>;
  startedAt: string | null;
  finishedAt: string | null;
};

export async function analysisProgress(projectId: string, kind: AnalysisKind): Promise<AnalysisProgress> {
  const db = await requireDb();
  const [job] = await db
    .select()
    .from(bookxAnalysisJobs)
    .where(and(eq(bookxAnalysisJobs.projectId, projectId), eq(bookxAnalysisJobs.kind, kind)))
    .orderBy(desc(bookxAnalysisJobs.createdAt))
    .limit(1);
  if (!job) {
    return { jobId: null, kind, status: "idle", totalSteps: 0, completedSteps: 0, percent: 0, message: null, events: [], errors: [], summary: {}, startedAt: null, finishedAt: null };
  }
  // A run that stopped checking in (a restart, a crash) is reported as failed
  // rather than left spinning forever.
  const stale = isStale(job) && !localRuns.has(job.id);
  const status: AnalysisStatus = stale ? "failed" : job.status;
  return {
    jobId: job.id,
    kind,
    status,
    totalSteps: job.totalSteps,
    completedSteps: job.completedSteps,
    percent: job.totalSteps ? Math.min(100, Math.round((job.completedSteps / job.totalSteps) * 100)) : status === "completed" ? 100 : 0,
    message: stale ? "Interrupted. Run it again; finished work is kept." : job.message,
    events: job.detail?.events ?? [],
    errors: job.detail?.errors ?? [],
    summary: job.detail?.summary ?? {},
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
}

export async function requestAnalysisCancel(projectId: string, jobId: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(bookxAnalysisJobs)
    .set({ cancelRequested: 1, updatedAt: new Date() })
    .where(and(eq(bookxAnalysisJobs.id, jobId), eq(bookxAnalysisJobs.projectId, projectId)));
}

/** On boot: runs that were in flight when the process stopped cannot finish. */
export async function recoverInterruptedAnalyses(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const stuck = await db.select({ id: bookxAnalysisJobs.id }).from(bookxAnalysisJobs).where(inArray(bookxAnalysisJobs.status, ["queued", "running"]));
  for (const job of stuck) {
    await db
      .update(bookxAnalysisJobs)
      .set({ status: "failed", message: "Interrupted by a restart. Run it again; finished work is kept.", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookxAnalysisJobs.id, job.id));
  }
  return stuck.length;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(lanes);
}
