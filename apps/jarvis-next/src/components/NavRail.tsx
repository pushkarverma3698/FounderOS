import { Network, Layers, Cpu, Activity, PieChart, ListOrdered } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';

export type RailTab = 'CORE' | 'PLAN' | 'ORG' | 'SYS' | 'DATA' | 'QUEUE';

const NAV_ITEMS: { id: RailTab; label: string; num: string; icon: any }[] = [
  { id: 'CORE', label: 'Graph orchestrator', num: '01', icon: Network },
  { id: 'PLAN', label: 'Typed execution', num: '02', icon: Layers },
  { id: 'ORG', label: 'Capability matrix', num: '03', icon: Cpu },
  { id: 'SYS', label: 'Failure & health', num: '04', icon: Activity },
  { id: 'DATA', label: 'Cost scoreboard', num: '05', icon: PieChart },
  { id: 'QUEUE', label: 'Job hunt queue', num: '06', icon: ListOrdered },
];

interface NavRailProps {
  activeTab: RailTab;
  onSelectTab: (tab: RailTab) => void;
}

export function NavRail({ activeTab, onSelectTab }: NavRailProps) {
  return (
    <nav className="w-16 shrink-0 flex flex-col items-center py-4 gap-3 z-50 relative bg-black/40 backdrop-blur-xl rounded-2xl border border-white/5 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
      {NAV_ITEMS.map((item) => {
        const active = activeTab === item.id;
        const Icon = item.icon;

        return (
          <button
            key={item.id}
            title={item.label}
            onClick={() => {
              soundEngine.click();
              onSelectTab(item.id);
            }}
            className={`relative w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-1 transition-all group ${
              active 
                ? 'bg-accent/20 text-accent shadow-[inset_0_0_12px_rgba(0,229,255,0.2),_0_0_15px_rgba(0,229,255,0.1)] border border-accent/20' 
                : 'text-white/40 hover:text-white/80 hover:bg-white/10 border border-transparent'
            }`}
          >
            {active && (
              <span
                className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r-md bg-accent"
                style={{ boxShadow: '0 0 10px var(--accent)' }}
              />
            )}
            <Icon className={`w-5 h-5 transition-transform ${active ? 'scale-110 drop-shadow-[0_0_8px_rgba(0,229,255,0.8)]' : 'group-hover:scale-110'}`} />
            <span
              className={`font-mono text-[9px] tracking-[0.1em] ${
                active ? 'font-bold' : 'font-medium'
              }`}
            >
              {item.num}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
