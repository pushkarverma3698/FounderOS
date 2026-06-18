import type { DepartmentId } from "../lib/types.js";
import { DEPARTMENTS } from "../lib/types.js";

interface DeptRailProps {
  activeDept: DepartmentId | null;
}

export function DeptRail({ activeDept }: DeptRailProps) {
  return (
    <aside className="dept-rail">
      {DEPARTMENTS.map((d) => (
        <div
          key={d}
          className={`dept-orb${activeDept === d ? " active" : ""}`}
          title={d}
        >
          <span>{d.slice(0, 3)}</span>
        </div>
      ))}
    </aside>
  );
}
