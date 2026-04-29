import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".c-suite")))

print("=== 1. Testing Component 2: Zero-Trust tool_hooks ===")
try:
    from tool_hooks import pre_tool_hook
    # Test Read-Only command
    res1 = pre_tool_hook("bash", "git status", "test_agent")
    print(f"Read-Only (git status)    -> Behavior: {res1.behavior}")
    
    # Test Destructive command
    res2 = pre_tool_hook("bash", "mkdir test_dir", "test_agent")
    print(f"Destructive (mkdir)       -> Behavior: {res2.behavior}")
    
    # Test Hard Deny
    res3 = pre_tool_hook("bash", "rm -rf /", "test_agent")
    print(f"Forbidden (rm -rf /)      -> Behavior: {res3.behavior}")
except Exception as e:
    print(f"Tool Hooks Test FAILED: {e}")


print("\n=== 2. Testing Component 3: security_auditor ===")
try:
    from security_auditor import CodebaseAuditor
    auditor = CodebaseAuditor()
    
    dummy_code = '''
def bad_function():
    # Hardcoded key
    my_api_key = "sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    
    # Infinite loop
    while True:
        print("Stuck!")
        
    print("Mixing turicks and naggar data!")
'''
    res = auditor.run_audit("/dev/null") # Hack to check string parsing
    # Overriding to test string directly
    results = {
        "secrets": auditor.scan_for_secrets(dummy_code),
        "infinite_loops": auditor.check_infinite_loops(dummy_code),
        "silo_breaches": auditor.verify_silo_isolation(dummy_code)
    }
    status = "PASSED" if not any(results.values()) else "FAILED_CRITICAL"
    print(f"Audit Status: {status}")
    print(f"Findings: {results}")
except Exception as e:
    print(f"Security Auditor Test FAILED: {e}")


print("\n=== 3. Testing Component 4: skill_library (Dynamic Prompts) ===")
try:
    from skill_library import get_expert_system_prompt, list_agents
    print(f"Registered Agents from JSON: {list_agents()}")
    
    prompt = get_expert_system_prompt("senior_dev", "Write me a React Button.")
    print("----- PROMPT PREVIEW -----")
    # Print the prompt but truncated slightly
    print(prompt[:300] + "\n...")
except Exception as e:
    print(f"Skill Library Test FAILED: {e}")
