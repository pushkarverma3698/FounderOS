import { Network, Layers, Cpu, Activity, PieChart } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';

export type RailTab = 'CORE' | 'PLAN' | 'ORG' | 'SYS' | 'DATA';

const NAV_ITEMS: { id: RailTab; label: string; num: string; icon: typeof Network }[] = [
  { id: 'CORE', label: 'Graph orchestrator', num: '01', icon: Network },
  { id: 'PLAN', label: 'Typed execution', num: '02', icon: Layers },
  { id: 'ORG', label: 'Capability matrix', num: '03', icon: Cpu },
  { id: 'SYS', label: 'Failure & health', num: '04', icon: Activity },
  { id: 'DATA', label: 'Cost scoreboard', num: '05', icon: PieChart },
];

interface NavRailProps {
  activeTab: RailTab;
  onSelectTab: (tab: RailTab) => void;
}

export function NavRail({ activeTab, onSelectTab }: NavRailProps) {
  return (
    <nav className="w-14 shrink-0 border-r border-accent/12 bg-void/60 backdrop-blur-xl flex flex-col items-center py-3 gap-1 z-50 relative">
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
            className={`relative w-11 h-12 flex flex-col items-center justify-center gap-1 transition-all group ${
              active ? 'text-accent' : 'text-chrome/25 hover:text-chrome/70'
            }`}
          >
            {active && (
              <span
                className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-7 bg-accent"
                style={{ boxShadow: '0 0 10px var(--accent)' }}
              />
            )}
            <Icon className="w-4 h-4 transition-transform group-hover:scale-110" />
            <span
              className={`font-mono text-[8px] tracking-[0.14em] ${
                active ? 'font-medium' : 'font-light'
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
