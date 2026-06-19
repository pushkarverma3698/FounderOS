interface HudHeaderProps {
  connected: boolean;
  voiceReply?: boolean;
  onVoiceReplyToggle?: () => void;
}

export function HudHeader({ connected, voiceReply, onVoiceReplyToggle }: HudHeaderProps) {
  return (
    <header className="hud-header">
      <div className="logo">◆ FounderOS JARVIS</div>
      <div className="hud-actions">
        {onVoiceReplyToggle && (
          <button
            type="button"
            className={`voice-reply-toggle${voiceReply ? " on" : ""}`}
            onClick={onVoiceReplyToggle}
            title="Speak assistant replies aloud"
          >
            {voiceReply ? "🔊 Voice on" : "🔇 Voice off"}
          </button>
        )}
        <div className={`status ${connected ? "live" : "off"}`}>
          {connected ? "LINKED" : "OFFLINE"}
        </div>
      </div>
    </header>
  );
}
