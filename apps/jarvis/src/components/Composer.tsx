interface ComposerProps {
  input: string;
  sending: boolean;
  recording: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onVoiceToggle: () => void;
}

export function Composer({ input, sending, recording, onChange, onSend, onVoiceToggle }: ComposerProps) {
  return (
    <div className="composer">
      <button
        type="button"
        className={`voice-btn${recording ? " recording" : ""}`}
        disabled={sending && !recording}
        onClick={onVoiceToggle}
        title={recording ? "Stop and send voice" : "Record voice command"}
        aria-label={recording ? "Stop recording" : "Start voice recording"}
      >
        {recording ? "⏹" : "🎙"}
      </button>
      <input
        value={input}
        disabled={sending || recording}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !sending && !recording && onSend()}
        placeholder="Command the office…"
      />
      <button type="button" disabled={sending || recording || !input.trim()} onClick={onSend}>
        {sending ? "…" : "Send"}
      </button>
    </div>
  );
}
