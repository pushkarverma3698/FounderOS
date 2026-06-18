interface ComposerProps {
  input: string;
  sending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}

export function Composer({ input, sending, onChange, onSend }: ComposerProps) {
  return (
    <div className="composer">
      <input
        value={input}
        disabled={sending}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !sending && onSend()}
        placeholder="Command the office…"
      />
      <button type="button" disabled={sending || !input.trim()} onClick={onSend}>
        {sending ? "…" : "Send"}
      </button>
    </div>
  );
}
