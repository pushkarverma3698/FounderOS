/**
 * Mac worker plan: packet answers -> fill actions
 * ===============================================
 * The Mac has no apply profile or dossier, only the packet: the answers the VPS form brain already chose for this
 * row (label, value, source, confidence). It scrapes the live form itself and matches each field to a packet answer
 * by label; the resume goes into the resume upload. A field with no answer becomes an `ask` (a required one blocks the
 * send via canAutoSend), so nothing is guessed on the Mac. Pure: no browser.
 */

import { normalizeQuestionKey } from "../tools/jobhunt/candidate-dossier.js";
import { labelMatches, type FormFillAction, type ScrapedField, type ScrapedFieldKind } from "../tools/jobhunt/form-brain.js";
import type { FormPlanSummary } from "../tools/jobhunt/form-filled.js";
import type { MacPacket } from "./mac-worker-packet.js";

type PacketAnswer = NonNullable<MacPacket["plan"]>["filledAnswers"][number];

const keyOf = (label: string): string => normalizeQuestionKey(label);

function answerFor(field: ScrapedField, answers: readonly PacketAnswer[]): PacketAnswer | undefined {
  const k = keyOf(field.label);
  return k === "" ? undefined : answers.find((a) => keyOf(a.label) === k);
}

const CHOICE: ReadonlySet<ScrapedFieldKind> = new Set(["select", "radio-group", "checkbox", "checkbox-group"]);

function ask(field: ScrapedField, why: string): FormFillAction {
  return {
    selector: field.selector, label: field.label, kind: "ask", question: field.label || "Question", required: field.required,
    fieldType: field.type, ...(field.options ? { options: field.options } : {}), why,
  };
}

export function planFromPacket(fields: readonly ScrapedField[], packet: MacPacket, cvPath: string): FormFillAction[] {
  const answers = packet.plan?.filledAnswers ?? [];
  const actions: FormFillAction[] = [];
  for (const field of fields) {
    if (field.isCaptcha || field.type === "captcha") continue;
    if (field.type === "file") {
      const coverOnly = labelMatches(field.label, "coverLetter") && !labelMatches(field.label, "resume");
      if (!coverOnly && (field.label === "" || labelMatches(field.label, "resume"))) {
        actions.push({ selector: field.selector, label: field.label || "Resume/CV", kind: "file", path: cvPath, confidence: 1, why: "resume/CV upload field" });
      } else {
        actions.push(ask(field, "no matching file in the packet for this upload"));
      }
      continue;
    }
    const answer = answerFor(field, answers);
    if (!answer) {
      actions.push(ask(field, "the VPS packet has no answer for this field"));
    } else if (CHOICE.has(field.type)) {
      actions.push({ selector: field.selector, label: field.label, kind: "choose", fieldType: field.type, option: answer.value, confidence: answer.confidence ?? 0, why: "packet answer" });
    } else {
      actions.push({ selector: field.selector, label: field.label, kind: "value", value: answer.value, confidence: answer.confidence ?? 0, why: "packet answer" });
    }
  }
  return actions;
}

/** summariseFormPlan classes sources from `why`; the Mac restores the source and confidence the VPS recorded. */
export function applyPacketSources(summary: FormPlanSummary, packet: MacPacket): FormPlanSummary {
  const answers = packet.plan?.filledAnswers ?? [];
  return {
    ...summary,
    filledAnswers: summary.filledAnswers.map((a) => {
      if (a.fieldType === "file") return { ...a, source: "file" as const, confidence: 1 };
      const hit = answers.find((p) => keyOf(p.label) === keyOf(a.label));
      return { ...a, source: hit?.source ?? ("unknown" as const), confidence: hit?.confidence ?? 0 };
    }),
  };
}
