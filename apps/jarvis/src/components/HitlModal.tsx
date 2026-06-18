import { useState } from "react";
import type { PendingHitl } from "../lib/types.js";

interface HitlModalProps {
  pending: PendingHitl;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export function HitlModal({ pending, busy, onApprove, onReject }: HitlModalProps) {
  return (
    <div className="hitl-modal">
      <h3>{pending.title}</h3>
      <p>{pending.summary}</p>
      {pending.preview && <pre className="hitl-preview">{pending.preview}</pre>}
      {pending.action && <p className="hitl-action">Action: {pending.action}</p>}
      <div className="hitl-actions">
        <button type="button" disabled={busy} onClick={onApprove}>
          Approve
        </button>
        <button type="button" className="reject" disabled={busy} onClick={onReject}>
          Reject
        </button>
      </div>
    </div>
  );
}

interface HitlModalContainerProps {
  pending: PendingHitl | null;
  onDecision: (decision: "approve" | "reject") => Promise<void>;
}

export function HitlModalContainer({ pending, onDecision }: HitlModalContainerProps) {
  const [busy, setBusy] = useState(false);
  if (!pending) return null;

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    try {
      await onDecision(decision);
    } finally {
      setBusy(false);
    }
  }

  return (
    <HitlModal
      pending={pending}
      busy={busy}
      onApprove={() => void decide("approve")}
      onReject={() => void decide("reject")}
    />
  );
}
