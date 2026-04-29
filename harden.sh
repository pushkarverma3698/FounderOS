#!/bin/bash
# FounderOS V8 — Sovereign Hardening Script
# ==========================================
# Run the internal Security Auditor across the entire .c-suite
# to identify loops, secret leaks, and data silo violations.

echo "🛡️ FounderOS V8: Sovereign Hardening in progress..."
echo "----------------------------------------------------"

# 1. Run the Python Security Auditor
python3 /Users/pushkarverma/FounderOS/.c-suite/security_auditor.py --scan-all

# 2. Check for missing Tool Documentation
echo "📚 Scanning for Documentation Gaps..."
find /Users/pushkarverma/FounderOS/.c-suite -maxdepth 1 -name "*.py" | while read -r file; do
    filename=$(basename "$file" .py)
    if [ ! -f "/Users/pushkarverma/FounderOS/docs/components/${filename}_doc.md" ]; then
        echo "  ⚠️ Missing Doc: ${filename}_doc.md"
    fi
done

# 3. Verify Registry Mapping
echo "📋 Verifying Central Registry..."
AGENT_COUNT=$(grep -c "Agent(" /Users/pushkarverma/FounderOS/.c-suite/registry.py)
echo "  ✅ Authorized Agents in Registry: $AGENT_COUNT"

echo "----------------------------------------------------"
echo "✅ Hardening Scan Complete. Review findings above."
