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
  const statusTone = offline || degraded ? 'text-signal drop-shadow-[0_0_8px_rgba(255,176,32,0.8)]' : connecting ? 'text-white/50' : 'text-accent drop-shadow-[0_0_8px_rgba(0,229,255,0.8)]';

  return (
    <header className="h-16 mx-4 mt-4 shrink-0 border border-white/5 bg-black/40 rounded-2xl backdrop-blur-xl px-6 flex items-center justify-between z-50 relative shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
      {/* Identity */}
      <div className="flex items-center gap-4">
        <span className="grid place-items-center w-10 h-10 rounded-xl border border-accent/20 bg-accent/10 shadow-[inset_0_0_15px_rgba(0,229,255,0.1)]">
          <span className="w-2.5 h-2.5 rounded-full bg-accent animate-breathe shadow-[0_0_12px_rgba(0,229,255,0.8)]" />
        </span>
        <span className="flex flex-col justify-center">
          <span className="font-sans font-bold text-[18px] tracking-[0.2em] text-white">FOUNDEROS</span>
          <span className="font-mono text-[9px] text-white/50 uppercase tracking-widest mt-0.5">headless kernel · 1 supervisor · 7 react depts</span>
        </span>
      </div>

      {/* Telemetry strip */}
      <div className="hidden lg:flex items-center gap-8 font-mono text-[11px] bg-black/30 px-6 py-2 rounded-full border border-white/5">
        <span className="flex items-center gap-2">
          <span className="text-white/40">kernel</span>
          <span className={`${statusTone} font-bold tracking-wide`}>{statusLabel}</span>
        </span>
        <span className="w-px h-3 bg-white/10" />
        <span className="flex items-center gap-2">
          <span className="text-white/40">db</span>
          <span className={`${offline || connecting ? 'text-white/30' : 'text-white/80'} font-medium tracking-wide`}>
            {dbStatus.toUpperCase()}
          </span>
        </span>
        <span className="w-px h-3 bg-white/10" />
        <span className="flex items-center gap-2">
          <span className="text-white/40">utc</span>
          <span className="text-white/80 font-medium tabular-nums tracking-widest">{clock}</span>
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            soundEngine.click();
            voiceEngine.listen((t) => onVoiceInput?.(t));
          }}
          title="Speak to Jarvis"
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-sans text-[11px] font-bold tracking-[0.1em] transition-all shadow-lg ${
            listening
              ? 'bg-signal text-black border border-signal shadow-[0_0_15px_rgba(255,176,32,0.4)]'
              : 'border border-accent/30 text-accent hover:bg-accent/10 hover:border-accent/60'
          }`}
        >
          <Mic className="w-3.5 h-3.5" />
          {listening ? 'LISTENING' : 'VOICE'}
        </button>

        <div className="flex bg-black/40 p-1 rounded-lg border border-white/5 gap-1">
          <button
            onClick={() => {
              const next = !soundMuted;
              setSoundMuted(next);
              soundEngine.setMuted(next);
              if (!next) soundEngine.click();
            }}
            title={soundMuted ? 'Unmute effects' : 'Mute effects'}
            className={`p-2 rounded-md transition-all ${
              soundMuted
                ? 'text-white/30 hover:text-white/60 hover:bg-white/5'
                : 'text-accent bg-accent/10 shadow-[0_0_10px_rgba(0,229,255,0.2)]'
            }`}
          >
            {soundMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            onClick={() => {
              const next = !voiceMuted;
              setVoiceMuted(next);
              voiceEngine.setMuted(next);
              if (!next) voiceEngine.speak('Voice telemetry enabled.');
            }}
            title={voiceMuted ? 'Enable voice feedback' : 'Disable voice feedback'}
            className={`p-2 rounded-md transition-all ${
              voiceMuted
                ? 'text-white/30 hover:text-white/60 hover:bg-white/5'
                : 'text-accent bg-accent/10 shadow-[0_0_10px_rgba(0,229,255,0.2)]'
            }`}
          >
            {voiceMuted ? <MicOff className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
          </button>
        </div>

        <select
          value={voiceEngine.getPersona()}
          onChange={(e) => {
            const persona = e.target.value as VoicePersona;
            voiceEngine.setPersona(persona);
            soundEngine.click();
            voiceEngine.speak(`Persona switched to ${persona}.`);
          }}
          title="Voice persona"
          className="bg-black/40 border border-white/5 rounded-lg text-accent font-sans text-[11px] font-semibold tracking-wider px-3 py-2 outline-none hover:border-accent/40 cursor-pointer transition-colors"
        >
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id} className="bg-[#111] text-white">
              {p.label}
            </option>
          ))}
        </select>

        <button
          onClick={onToggleMode}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-sans text-[11px] font-bold tracking-[0.15em] border transition-all ${
            mode === 'LIVE'
              ? 'bg-accent/20 text-accent border-accent/40 shadow-[0_0_15px_rgba(0,229,255,0.2)]'
              : 'border-signal/40 text-signal bg-signal/10 hover:bg-signal/20'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${mode === 'LIVE' ? 'bg-accent animate-breathe shadow-[0_0_8px_rgba(0,229,255,0.8)]' : 'bg-signal shadow-[0_0_8px_rgba(255,176,32,0.8)]'}`}
          />
          {mode === 'LIVE' ? 'LIVE' : 'REPLAY'}
        </button>
      </div>
    </header>
  );
}
