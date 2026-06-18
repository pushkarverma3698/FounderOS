interface HudHeaderProps {
  connected: boolean;
}

export function HudHeader({ connected }: HudHeaderProps) {
  return (
    <header className="hud-header">
      <div className="logo">◆ FounderOS JARVIS</div>
      <div className={`status ${connected ? "live" : "off"}`}>
        {connected ? "LINKED" : "OFFLINE"}
      </div>
    </header>
  );
}
