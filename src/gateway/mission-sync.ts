/**
 * FounderOS — Mission sync (trace → MISO state + dashboard refresh)
 */

import type { TurnTrace, Seam } from "../infra/trace.js";
import {
  getActiveMission,
  updateMissionPhase,
  setMissionTelegramMsg,
} from "../db/queries.js";
import {
  departmentFromRouteHint,
  formatMisoDashboard,
  missionToView,
  nextActionFromTrace,
  phaseFromTrace,
  PHASE_REACTION,
} from "./mission-control.js";
import { departmentFromTransferTool } from "./dept-routing.js";
import { publishStreamEvent } from "./stream-hub.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "mission-sync" });

/** Per-department status once a mission reaches a terminal phase. */
const TERMINAL_AGENT_STATUS: Partial<Record<string, string>> = {
  COMPLETE: "done",
  ERROR: "error",
  CANCELLED: "cancelled",
};

export async function syncMissionTrace(
  sessionId: string,
  trace: TurnTrace,
  seam: Seam,
  data?: Record<string, unknown>,
): Promise<void> {
  const mission = await getActiveMission(sessionId).catch(() => null);
  if (!mission) return;

  const phase = phaseFromTrace(seam, data);
  const nextAction = nextActionFromTrace(seam, data);
  let department = mission.department;
  if (seam === "route.decided" && data?.hint) {
    department = departmentFromRouteHint(String(data.hint)) ?? department;
  }
  if (seam === "tool.call") {
    const toolName = data?.["name"] ?? data?.["tool"] ?? data?.["toolName"];
    if (typeof toolName === "string") {
      department = departmentFromTransferTool(toolName) ?? department;
    }
  }

  const agentStatuses = { ...(mission.agent_statuses ?? {}) };
  if (department) {
    const terminalStatus = phase ? TERMINAL_AGENT_STATUS[phase] : undefined;
    agentStatuses[department] =
      terminalStatus ?? (phase === "AWAITING APPROVAL" ? "awaiting approval" : "active");
  }

  if (phase || nextAction || department) {
    await updateMissionPhase(mission.mission_id, {
      ...(phase ? { phase } : {}),
      ...(nextAction ? { next_action: nextAction } : {}),
      ...(department ? { department } : {}),
      agent_statuses: agentStatuses,
      turn_id: trace.turnId,
      ...(phase === "COMPLETE" || phase === "ERROR" || phase === "CANCELLED"
        ? { completed_at: new Date() }
        : {}),
    }).catch((err) => log.warn({ err: (err as Error).message }, "Mission phase update failed"));
  }

  publishStreamEvent(sessionId, {
    type: "mission.updated",
    data: { missionId: mission.mission_id, seam, phase, nextAction },
  });

  if (mission.telegram_msg_id) {
    await refreshMissionDashboard(sessionId, mission.mission_id).catch(() => {});
  }
}

export async function refreshMissionDashboard(sessionId: string, missionId: string): Promise<void> {
  const { getMissionById } = await import("../db/queries.js");
  const row = await getMissionById(missionId);
  if (!row) return;

  const text = formatMisoDashboard(missionToView(row));
  const chatId = sessionId;

  if (row.telegram_msg_id) {
    try {
      const { getBot } = await import("./telegram.js");
      const bot = getBot();
      await bot.api.editMessageText(chatId, row.telegram_msg_id, text);
      const reaction = PHASE_REACTION[row.phase as keyof typeof PHASE_REACTION];
      if (reaction) {
        await bot.api.setMessageReaction(chatId, row.telegram_msg_id, [{ type: "emoji", emoji: reaction as "🔥" }]).catch(() => {});
      }
    } catch (err) {
      log.warn({ missionId, err: (err as Error).message }, "Mission dashboard edit failed");
    }
  }

  publishStreamEvent(sessionId, {
    type: "mission.updated",
    data: { missionId, dashboard: text, phase: row.phase },
  });
}

export async function postMissionDashboard(
  sessionId: string,
  missionId: string,
): Promise<number | null> {
  const { getMissionById } = await import("../db/queries.js");
  const row = await getMissionById(missionId);
  if (!row) return null;

  const text = formatMisoDashboard(missionToView(row));
  try {
    const { getBot } = await import("./telegram.js");
    const bot = getBot();
    const msg = await bot.api.sendMessage(sessionId, text);
    await setMissionTelegramMsg(missionId, msg.message_id);
    try {
      await bot.api.pinChatMessage(sessionId, msg.message_id, { disable_notification: true });
    } catch {
      /* pin optional */
    }
    return msg.message_id;
  } catch (err) {
    log.warn({ missionId, err: (err as Error).message }, "Mission dashboard post failed");
    return null;
  }
}
