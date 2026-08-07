import React, { useState, useEffect } from 'react';
import { Volume2, VolumeX, Mic, MicOff, RefreshCw, Cpu, Database, Activity } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine } from '../audio/voiceEngine';

interface HeaderProps {
  mode: 'LIVE' | 'REPLAY';
  onToggleMode: () => void;
  systemStatus: 'ok' | 'degraded' | 'syncing';
  spendToday: number;
  dbStatus: string;
  onVoiceInput?: (text: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  mode,
  onToggleMode,
  systemStatus,
  spendToday,
  dbStatus,
  onVoiceInput,
}) => {
  const [timeStr, setTimeStr] = useState('');
  const [soundMuted, setSoundMuted] = useState(soundEngine.isMuted());
  const [voiceMuted, setVoiceMuted] = useState(voiceEngine.isMuted());
  const [isListening, setIsListening] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const d = new Date();
      setTimeStr(
        d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
        ' IST (' + d.toISOString().slice(0, 10) + ')'
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsubscribe = voiceEngine.subscribe((state) => {
      setIsListening(state.isListening);
    });
    return unsubscribe;
  }, []);

  const toggleSound = () => {
    const next = !soundMuted;
    setSoundMuted(next);
    soundEngine.setMuted(next);
    if (!next) soundEngine.click();
  };

  const toggleVoice = () => {
    const next = !voiceMuted;
    setVoiceMuted(next);
    voiceEngine.setMuted(next);
    if (!next) voiceEngine.speak('Voice telemetry enabled.');
  };

  const handleStartListening = () => {
    soundEngine.click();
    voiceEngine.speak('Listening for voice command...');
    voiceEngine.listen((transcript) => {
      if (onVoiceInput) {
        onVoiceInput(transcript);
      }
    });
  };

  return (
    <header className="h-[60px] bg-[#03060c]/90 border-b border-[#5eead4]/30 backdrop-blur-md px-4 flex items-center justify-between z-30 sticky top-0">
      {/* Brand & System Identifier */}
      <div className="flex items-center space-x-3">
        <div className="relative flex items-center justify-center w-8 h-8 rounded border border-[#5eead4]/40 bg-[#0b1624] shadow-[0_0_15px_rgba(94,234,212,0.4)]">
          <Cpu className="w-5 h-5 text-[#5eead4] animate-pulse" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <span className="font-display font-bold text-base tracking-widest text-[#dbeaf0]">FOUNDEROS</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#5eead4]/10 text-[#5eead4] border border-[#5eead4]/30 uppercase">
              JARVIS v2035
            </span>
          </div>
          <p className="text-[10px] font-mono text-slate-400 tracking-wider">EXECUTIVE INTELLIGENCE COMMAND KERNEL</p>
        </div>
      </div>

      {/* Center Metrics & Telemetry */}
      <div className="hidden md:flex items-center space-x-6 font-mono text-xs">
        <div className="flex items-center space-x-2 px-3 py-1 rounded bg-[#0b1624]/60 border border-slate-700/60">
          <Activity className="w-3.5 h-3.5 text-[#5eead4]" />
          <span className="text-slate-400">STATUS:</span>
          <span className={`font-bold ${systemStatus === 'ok' ? 'text-[#5eead4]' : 'text-amber-400'}`}>
            {systemStatus === 'ok' ? 'NOMINAL' : 'DEGRADED'}
          </span>
        </div>

        <div className="flex items-center space-x-2 px-3 py-1 rounded bg-[#0b1624]/60 border border-slate-700/60">
          <Database className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-slate-400">DB:</span>
          <span className="text-[#dbeaf0] font-semibold">{dbStatus.toUpperCase()}</span>
        </div>

        <div className="flex items-center space-x-2 px-3 py-1 rounded bg-[#0b1624]/60 border border-slate-700/60">
          <span className="text-slate-400">SPEND TODAY:</span>
          <span className="text-[#5eead4] font-bold">${spendToday.toFixed(4)}</span>
        </div>

        <div className="text-slate-400 font-mono text-[11px] tracking-widest">
          {timeStr || '00:00:00 IST'}
        </div>
      </div>

      {/* Controls & Mode Selector */}
      <div className="flex items-center space-x-3">
        {/* Voice Command Mic Trigger Button */}
        <button
          onClick={handleStartListening}
          title="Speak to Jarvis (Voice Input)"
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded font-mono text-xs font-bold border transition-all ${
            isListening
              ? 'border-amber-400 text-black bg-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.6)] animate-pulse'
              : 'border-[#5eead4]/40 text-[#5eead4] bg-[#5eead4]/10 hover:bg-[#5eead4]/20'
          }`}
        >
          <Mic className="w-3.5 h-3.5" />
          <span>{isListening ? 'LISTENING...' : 'VOICE COMMAND'}</span>
        </button>

        {/* Audio Toggles */}
        <button
          onClick={toggleSound}
          title={soundMuted ? 'Unmute Sound Effects' : 'Mute Sound Effects'}
          className={`p-1.5 rounded border transition-colors ${
            soundMuted
              ? 'border-slate-700 text-slate-500 hover:text-slate-300'
              : 'border-[#5eead4]/40 text-[#5eead4] bg-[#5eead4]/10'
          }`}
        >
          {soundMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>

        <button
          onClick={toggleVoice}
          title={voiceMuted ? 'Enable Voice Feedback' : 'Disable Voice Feedback'}
          className={`p-1.5 rounded border transition-colors ${
            voiceMuted
              ? 'border-slate-700 text-slate-500 hover:text-slate-300'
              : 'border-indigo-400/40 text-indigo-400 bg-indigo-400/10'
          }`}
        >
          {voiceMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

        {/* Persona Selector Dropdown */}
        <select
          value={voiceEngine.getPersona()}
          onChange={(e) => {
            const persona = e.target.value as any;
            voiceEngine.setPersona(persona);
            soundEngine.click();
            voiceEngine.speak(`Persona switched to ${persona}.`);
          }}
          className="bg-[#0b1624] border border-[#5eead4]/40 text-[#5eead4] font-mono text-xs font-bold rounded px-2 py-1.5 outline-none hover:border-[#5eead4] cursor-pointer"
          title="Select Voice Persona & Humor Style"
        >
          <option value="JARVIS">🇬🇧 JARVIS (British Executive)</option>
          <option value="CYBERPUNK">⚡ CYBERPUNK 2035 (High Energy)</option>
          <option value="SARKY_CTO">😏 SARKY CTO (Sarcastic Engineer)</option>
        </select>

        {/* Live / Replay Mode Toggle */}
        <button
          onClick={onToggleMode}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded font-mono text-xs font-bold border transition-all ${
            mode === 'LIVE'
              ? 'border-[#5eead4] text-black bg-[#5eead4] shadow-[0_0_15px_rgba(94,234,212,0.4)]'
              : 'border-amber-400/50 text-amber-400 bg-amber-400/10 hover:bg-amber-400/20'
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${mode === 'LIVE' ? 'animate-spin' : ''}`} />
          <span>{mode === 'LIVE' ? 'LIVE TELEMETRY' : 'REPLAY MODE'}</span>
        </button>
      </div>
    </header>
  );
};
