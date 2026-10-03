/** Pure verdict for golden journey C (30-day plan): did the bot post in the jobs group recently? */
export interface GroupMessage {
  fromId: number | undefined;
  date: number; // unix seconds, as MTProto returns it
  text: string;
}

export interface JourneyVerdict {
  ok: boolean;
  detail: string;
}

export function judgeJobsGroup(messages: GroupMessage[], botId: number, nowMs: number, maxAgeHours: number): JourneyVerdict {
  const fromBot = messages.filter((m) => m.fromId === botId).sort((a, b) => b.date - a.date);
  const latest = fromBot[0];
  if (!latest) return { ok: false, detail: `no bot message in the last ${messages.length} messages` };
  const ageH = (nowMs - latest.date * 1000) / 3_600_000;
  const preview = latest.text.replace(/\s+/g, " ").slice(0, 60);
  return {
    ok: ageH <= maxAgeHours,
    detail: `latest bot message ${ageH.toFixed(1)}h ago (limit ${maxAgeHours}h): "${preview}"`,
  };
}
