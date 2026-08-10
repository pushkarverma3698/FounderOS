import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine } from '../audio/voiceEngine';

const HISTORY_LIMIT = 30;

interface CommandBarProps {
  onDispatch: (prompt: string) => void;
  /** Disabled while the kernel gateway is unreachable. */
  disabled?: boolean;
}

/**
 * The dispatch line. Owns its own history (↑/↓) and a "/" focus shortcut, because
 * the founder types into this far more often than he clicks anything else.
 */
export function CommandBar({ onDispatch, disabled = false }: CommandBarProps) {
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the command line from anywhere, Escape releases it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && el === inputRef.current) inputRef.current?.blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = prompt.trim();
    if (!value || disabled) return;
    soundEngine.dispatch();
    voiceEngine.speak(`Dispatching: ${value}`);
    onDispatch(value);
    setHistory((h) => [value, ...h.filter((x) => x !== value)].slice(0, HISTORY_LIMIT));
    setCursor(-1);
    setPrompt('');
  };

  const navigateHistory = (direction: 1 | -1) => {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(-1, cursor + direction));
    setCursor(next);
    setPrompt(next === -1 ? '' : history[next]);
  };

  return (
    <form
      onSubmit={submit}
      className="absolute left-1/2 -translate-x-1/2 bottom-6 z-40 w-[min(760px,74vw)] hud-panel ticks flex items-center gap-3 px-4 py-3 glow-accent"
    >
      <span className="label-micro shrink-0 !text-accent/80">DISPATCH</span>
      <span className="w-px h-5 bg-accent/20" />
      <input
        ref={inputRef}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setCursor(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateHistory(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateHistory(-1);
          }
        }}
        disabled={disabled}
        placeholder={
          disabled
            ? 'Kernel gateway unreachable — dispatch disabled'
            : 'Command the supervisor    ( / to focus, ↑ for history )'
        }
        aria-label="Command the supervisor"
        className="flex-1 bg-transparent font-mono font-light text-[12px] text-chrome placeholder:text-chrome/25 focus:outline-none disabled:cursor-not-allowed"
      />
      <button
        type="submit"
        disabled={disabled || !prompt.trim()}
        className="shrink-0 flex items-center gap-1 px-4 py-1.5 bg-accent text-void font-display font-bold text-[11px] tracking-[0.18em] transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
      >
        EXECUTE
        <ChevronRight className="w-3.5 h-3.5" strokeWidth={3} />
      </button>
    </form>
  );
}
