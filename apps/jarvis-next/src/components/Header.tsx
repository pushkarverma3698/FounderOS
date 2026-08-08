import { useEffect, useState } from 'react';
import { Volume2, VolumeX, Mic, MicOff, Radio } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine, type VoicePersona } from '../audio/voiceEngine';

interface HeaderProps {
  mode: 'LIVE' | 'REPLAY';
  onToggleMode: () => void;
  systemStatus: 'ok' | 'degraded' | 'syncing';
  dbStatus: string;
  /** Whether the kernel gateway is answering at all. */
  gateway: 'connecting' | 'online' | 'offline';
  onVoiceInput?: (text: string) => void;
}

const PERSONAS: { id: VoicePersona; label: string }[] = [
  { id: 'JARVIS', label: 'JARVIS · BRITISH EXEC' },
  { id: 'CYBERPUNK', label: 'CYBERPUNK · HIGH ENERGY' },
  { id: 'SARKY_CTO', label: 'SARKY CTO · SARCASTIC' },
];

export function Header({
  mode,
  onToggleMode,
  systemStatus,
  dbStatus,
  gateway,
  onVoiceInput,
}: HeaderProps) {
  const [clock, setClock] = useState('');
  const [soundMuted, setSoundMuted] = useState(soundEngine.isMuted());
  const [voiceMuted, setVoiceMuted] = useState(voiceEngine.isMuted());
  const [listening, setListening] = useState(false);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(d.toLocaleTimeString('en-GB', { hour12: false }));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => voiceEngine.subscribe((s) => setListening(s.isListening)), []);

  const offline = gateway === 'offline';
  const connecting = gateway === 'connecting';
  const degraded = systemStatus !== 'ok';

  // "Cannot reach the kernel" outranks any cached health reading.
  const statusLabel = offline
    ? 'UNREACHABLE'
    : connecting
    ? 'CONNECTING'
    : degraded
    ? 'DEGRADED'
    : 'NOMINAL';
  const statusTone = offline || degraded ? 'text-signal' : connecting ? 'text-chrome/50' : 'text-accent';

  return (
    <header className="h-14 shrink-0 border-b border-accent/12 bg-void/80 backdrop-blur-xl px-4 flex items-center justify-between z-50 relative">
      {/* Identity */}
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-8 h-8 border border-accent/40 bg-accent/8">
          <span className="w-2 h-2 bg-accent animate-breathe" style={{ boxShadow: '0 0 12px var(--accent)' }} />
        </span>
        <span className="flex flex-col leading-none">
          <span className="value-heavy text-[15px] tracking-[0.26em] text-chrome">FOUNDEROS</span>
          <span className="label-micro mt-1">headless kernel · 1 supervisor · 7 react depts</span>
        </span>
      </div>

      {/* Telemetry strip */}
      <div className="hidden lg:flex items-center gap-6 font-mono text-[10px]">
        <span className="flex items-center gap-2">
          <span className="label-micro">kernel</span>
          <span className={`${statusTone} font-medium`}>{statusLabel}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="label-micro">db</span>
          <span className={offline || connecting ? 'text-chrome/30 font-light' : 'text-chrome/75 font-light'}>
            {dbStatus.toUpperCase()}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="label-micro">utc</span>
          <span className="text-chrome/75 font-light tabular-nums tracking-widest">{clock}</span>
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            soundEngine.click();
            voiceEngine.listen((t) => onVoiceInput?.(t));
          }}
          title="Speak to Jarvis"
          className={`flex items-center gap-1.5 px-3 py-1.5 border font-mono text-[10px] font-medium tracking-[0.16em] transition-all ${
            listening
              ? 'bg-signal text-void border-signal'
              : 'border-accent/35 text-accent hover:bg-accent/10'
          }`}
        >
          <Mic className="w-3 h-3" />
          {listening ? 'LISTENING' : 'VOICE'}
        </button>

        <button
          onClick={() => {
            const next = !soundMuted;
            setSoundMuted(next);
            soundEngine.setMuted(next);
            if (!next) soundEngine.click();
          }}
          title={soundMuted ? 'Unmute effects' : 'Mute effects'}
          className={`p-1.5 border transition-colors ${
            soundMuted
              ? 'border-accent/12 text-chrome/25 hover:text-chrome/60'
              : 'border-accent/35 text-accent'
          }`}
        >
          {soundMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={() => {
            const next = !voiceMuted;
            setVoiceMuted(next);
            voiceEngine.setMuted(next);
            if (!next) voiceEngine.speak('Voice telemetry enabled.');
          }}
          title={voiceMuted ? 'Enable voice feedback' : 'Disable voice feedback'}
          className={`p-1.5 border transition-colors ${
            voiceMuted
              ? 'border-accent/12 text-chrome/25 hover:text-chrome/60'
              : 'border-accent/35 text-accent'
          }`}
        >
          {voiceMuted ? <MicOff className="w-3.5 h-3.5" /> : <Radio className="w-3.5 h-3.5" />}
        </button>

        <select
          value={voiceEngine.getPersona()}
          onChange={(e) => {
            const persona = e.target.value as VoicePersona;
            voiceEngine.setPersona(persona);
            soundEngine.click();
            voiceEngine.speak(`Persona switched to ${persona}.`);
          }}
          title="Voice persona"
          className="bg-panel border border-accent/25 text-accent font-mono text-[10px] font-light tracking-wider px-2 py-1.5 outline-none hover:border-accent/60 cursor-pointer"
        >
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id} className="bg-panel">
              {p.label}
            </option>
          ))}
        </select>

        <button
          onClick={onToggleMode}
          className={`flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] font-bold tracking-[0.16em] border transition-all ${
            mode === 'LIVE'
              ? 'bg-accent text-void border-accent'
              : 'border-signal/50 text-signal hover:bg-signal/10'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${mode === 'LIVE' ? 'bg-void animate-breathe' : 'bg-signal'}`}
          />
          {mode === 'LIVE' ? 'LIVE' : 'REPLAY'}
        </button>
      </div>
    </header>
  );
}
