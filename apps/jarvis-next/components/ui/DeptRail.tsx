"use client";

import { DEPARTMENTS } from "@/lib/jarvis-api";
import { motion } from "framer-motion";

export function DeptRail({ activeDept }: { activeDept: string | null }) {
  return (
    <nav className="dept-rail" aria-label="Departments">
      {DEPARTMENTS.map((d, i) => {
        const active = activeDept?.includes(d.id) ?? false;
        return (
          <motion.div
            key={d.id}
            className={`dept-node ${active ? "active" : ""}`}
            style={{ "--dept-color": d.color } as Record<string, string>}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.06 }}
            title={d.label}
          >
            <span className="dept-abbr">{d.label.slice(0, 3).toUpperCase()}</span>
            <span className="dept-name">{d.label}</span>
          </motion.div>
        );
      })}
    </nav>
  );
}
