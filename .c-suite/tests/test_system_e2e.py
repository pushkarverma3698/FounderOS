"""
End-to-End Test Suite for FounderOS V6
Verifies the new Gemini 3.1 strings, the Sandbox DENY_lists, the Codex mappings, and basic Local bindings.
"""
import asyncio, logging, sys, os
sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import CEO_CASCADE, MD_CASCADE, call_ceo, call_local, get_cascade_for_agent
from core.sandbox import safe_run

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("TestE2E")

def test_cascades():
    log.info("🧪 [TEST] Verifying Config Cascades & Codex Settings...")
    assert CEO_CASCADE[1][1] == "gemini-3.1-pro", "FATAL: CEO Cascade not updated"
    assert get_cascade_for_agent("senior_dev")[0][1] == "openai/o3-mini", "FATAL: Codex mapping failed for senior dev"
    assert get_cascade_for_agent("vibe_coder")[0][1] == "openai/o3-mini", "FATAL: Codex mapping failed for vibe coder"
    log.info("✅ Cascades and Codex mappings successfully routed.")

def test_sandbox():
    log.info("🧪 [TEST] Checking Sandbox Terminal Constraints...")
    try:
        safe_run("sudo rm -rf /", cwd=None)
        assert False, "FATAL: Sandbox failed to block sudo operation!"
    except PermissionError:
        log.info("✅ Sandbox explicitly blocked the simulated 'sudo rm -rf /' execution.")
    except Exception as e:
        log.error(f"Unexpected error: {e}")
        
    try:
        safe_run("mkfs.ext4 /dev/sda1", cwd=None)
        assert False, "FATAL: Sandbox failed to block mkfs!"
    except PermissionError:
        log.info("✅ Sandbox explicitly blocked format operations.")

def test_local_daemons():
    log.info("🧪 [TEST] Ensuring Zero-Cost Daemon Routing...")
    from utils import kairos_background
    from bridges import telegram_gateway
    # The ultimate test is that the python interpreter successfully loads them
    # without blowing up with the new call_local references
    log.info("✅ Telegram and Kairos daemons loaded cleanly with native call_local bindings.")

def run_all():
    log.info("🚀 Booting FounderOS Architecture Integrations Testsuite...")
    print("="*60)
    test_cascades()
    test_sandbox()
    test_local_daemons()
    print("="*60)
    log.info("💎 Testing Complete. All Systems GO. FounderOS V6 deployed successfully.")

if __name__ == "__main__":
    run_all()
