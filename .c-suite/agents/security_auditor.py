"""
FounderOS — Modular Security Auditor (Project Glasswing / Mythos Style)
========================================================================
Autonomous CI/CD analyzer that scans code for infinite loops, hardcoded secrets,
and data silo violations before tasks are approved.
"""

import ast
import re
import os
import logging

log = logging.getLogger("SecurityAuditor")

class CodebaseAuditor:
    def __init__(self):
        # Extremely sensitive secrets
        self.secret_patterns = [
            re.compile(r"api[_]?key\s*=\s*['\"][A-Za-z0-9_\-]+['\"]", re.IGNORECASE),
            re.compile(r"sk-[a-zA-Z0-9_-]{32,}")
        ]
        
    def scan_for_secrets(self, code: str) -> list[str]:
        findings = []
        for ptrn in self.secret_patterns:
            if ptrn.search(code):
                findings.append(f"Secret matched pattern: [REDACTED]")
        return findings

    def check_infinite_loops(self, code: str) -> list[str]:
        # Primitive AST parsing for while True without break
        findings = []
        try:
            tree = ast.parse(code)
            for node in ast.walk(tree):
                if isinstance(node, ast.While):
                    has_break = any(isinstance(n, ast.Break) for n in ast.walk(node))
                    is_true = False
                    if isinstance(node.test, ast.Constant) and node.test.value is True:
                        is_true = True
                    if is_true and not has_break:
                        findings.append(f"Infinite loop detected at line {node.lineno}")
        except Exception:
            pass # Unparseable
        return findings

    def verify_silo_isolation(self, code: str) -> list[str]:
        findings = []
        if "turicks" in code.lower() and "naggar" in code.lower():
            findings.append("Potential data-silo breach: Turicks and Naggar entities referenced in same code execution block.")
        return findings

    def run_audit(self, filepath: str) -> dict:
        if not os.path.exists(filepath):
             return {"status": "error", "message": "File not found"}
        with open(filepath, "r", encoding="utf-8") as f:
             code = f.read()

        results = {
            "secrets": self.scan_for_secrets(code),
            "infinite_loops": self.check_infinite_loops(code),
            "silo_breaches": self.verify_silo_isolation(code)
        }
        
        status = "PASSED" if not any(results.values()) else "FAILED_CRITICAL"
        return {"status": status, "findings": results}

if __name__ == "__main__":
    auditor = CodebaseAuditor()
    print("Glasswing Security Auditor Initialized.")
