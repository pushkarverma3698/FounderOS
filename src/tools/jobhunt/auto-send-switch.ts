/**
 * Auto-send: the per-profile runtime switch (`/autoapply on|off|status`)
 * =====================================================================
 * A tiny JSON file beside the apply profiles (`auto-send-<profile>.json` under the data root, which survives a
 * deploy). No settings table exists. Off when the file is missing, unreadable or says anything but `on: true`:
 * a switch that cannot be read is a switch that is off. The env switch (`AUTO_APPLY_SEND`) is separate; both
 * must be on to send.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { applyProfilePathFor } from "./apply-profile.js";
import { atomicWrite } from "./atomic-write.js";

const fileSchema = z.object({ on: z.boolean(), changedAt: z.string() });

export function autoSendSwitchPath(profileId: string): string {
  return join(dirname(applyProfilePathFor(profileId)), `auto-send-${profileId}.json`);
}

/** `never_set` is a profile with no switch file at all (nobody has ever run `/autoapply on|off` for it); it acts as off. */
export type SwitchState = "on" | "off" | "never_set";

export async function readSwitchState(profileId: string): Promise<SwitchState> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(await fs.readFile(autoSendSwitchPath(profileId), "utf8")));
    return parsed.success && parsed.data.on ? "on" : "off";
  } catch (err) {
    // allow-failopen: this is a kill switch, so an unreadable file reads as OFF, the safe side.
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "never_set" : "off";
  }
}

export async function readRuntimeSwitch(profileId: string): Promise<boolean> {
  return (await readSwitchState(profileId)) === "on";
}

export async function writeRuntimeSwitch(profileId: string, on: boolean, now: Date = new Date()): Promise<void> {
  await atomicWrite(autoSendSwitchPath(profileId), `${JSON.stringify({ on, changedAt: now.toISOString() })}\n`);
}
