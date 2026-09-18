import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { applicationTasks, jobApplications, type ApplicationTask, type JobApplication } from "../../db/schema.js";
import { childLogger } from "../../infra/logger.js";
import { getProfile } from "../../tools/jobhunt/profile-config.js";
import { buildApplicationPacket, type ApplicationPacket } from "../../tools/jobhunt/apply-packet.js";
import { BrowserApplicationExecutor } from "./browser-executor.js";
import { handleBrowserException } from "./ai-runtime-handler.js";

const log = childLogger({ module: "jobhunt:operator" });

export class JobApplicationOperator {
  constructor(private artifactDir: string) {}

  /**
   * Run one iteration of the operator loop: pick one job and process it.
   */
  async runNext(): Promise<void> {
    const task = await this.dequeueTask();
    if (!task) {
      log.debug("No queued application tasks.");
      return;
    }

    try {
      await this.processTask(task);
    } catch (err) {
      log.error({ taskId: task.task.id, err }, "Operator failed processing task");
      await this.transitionState(task.task.id, "FAILED", String(err));
    }
  }

  private async dequeueTask() {
    // Find a QUEUED or READY task, preferring READY
    const tasks = await db.select()
      .from(applicationTasks)
      .innerJoin(jobApplications, eq(applicationTasks.job_id, jobApplications.id))
      .where(and(
        eq(applicationTasks.tenant_id, "turicks"),
        // Allow polling QUEUED or READY
      ))
      .orderBy(applicationTasks.created_at) // just an example, should prefer READY and older
      .limit(50);
      
    // Filter in-memory for simpler query (since drizzle OR on enums can be verbose)
    const task = tasks.find(t => t.application_tasks.state === "READY" || t.application_tasks.state === "QUEUED");
    if (!task) return null;

    return {
      task: task.application_tasks,
      row: task.job_applications
    };
  }

  private async transitionState(taskId: string, state: ApplicationTask["state"], errorDetails?: string) {
    await db.update(applicationTasks)
      .set({ state, error_details: errorDetails, updated_at: new Date() })
      .where(eq(applicationTasks.id, taskId));
    log.info({ taskId, state }, `Transitioned task state to ${state}`);
  }

  private async processTask({ task, row }: { task: ApplicationTask, row: JobApplication }) {
    if (row.stage === "applied" || row.stage === "rejected" || row.stage === "skipped") {
      log.warn({ jobId: row.id }, "Job already applied/rejected/skipped. Marking task SKIPPED.");
      await this.transitionState(task.id, "SKIPPED", "Already handled in jobApplications");
      return;
    }

    log.info({ taskId: task.id, jobId: row.id, profile: task.profile_id }, "Processing application task");
    
    await this.transitionState(task.id, "PREPARING");
    
    // Get ApplicationPacket
    const packetResult = await buildApplicationPacket(row, this.artifactDir);
    if (!packetResult.ok) {
      await this.transitionState(task.id, "FAILED", `Packet generation failed: ${packetResult.reason}`);
      return;
    }
    
    const packet = packetResult.packet;
    await this.transitionState(task.id, "READY");
    
    // Begin browser execution
    await this.transitionState(task.id, "OPENING");
    
    const executor = new BrowserApplicationExecutor();
    try {
      await executor.execute(packet, task.profile_id, async (newState) => {
        await this.transitionState(task.id, newState);
      });
      
      await this.transitionState(task.id, "APPLIED");
      // Update main row
      await db.update(jobApplications)
        .set({ stage: "applied", applied_at: new Date() })
        .where(eq(jobApplications.id, row.id));

    } catch (err: any) {
      log.error({ err }, "Browser automation exception");
      
      const recovered = await handleBrowserException(executor, packet, err);
      if (recovered) {
         // Optionally try to resume, or mark manual intervention
         await this.transitionState(task.id, "BLOCKED", "AI escalated or human required");
      } else {
         await this.transitionState(task.id, "FAILED", err.message);
      }
    } finally {
      await executor.close();
    }
  }
}
