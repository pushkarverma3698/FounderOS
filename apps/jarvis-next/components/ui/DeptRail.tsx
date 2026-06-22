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
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ 
              delay: i * 0.08, 
              duration: 1.0, 
              ease: [0.16, 1, 0.3, 1] 
            }}
            whileHover={{ 
              scale: 1.05, 
              borderColor: d.color,
              backgroundColor: "rgba(255, 255, 255, 0.02)" 
            }}
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
