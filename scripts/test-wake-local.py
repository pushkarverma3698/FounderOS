import os
import subprocess

print("=== Testing Mac Alive Flow (mac_client.wake) ===")
print("Sourcing credentials from .env.prod...")

# Read .env.prod and populate os.environ
with open('.env.prod', 'r') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            k, v = line.split('=', 1)
            os.environ[k] = v.strip('"\'')

print("Starting wake.py...")
result = subprocess.run(
    [".venv/bin/python", "-m", "mac_client.wake"], 
    cwd="mac-client", 
    env=os.environ
)

if result.returncode == 0:
    print("✅ wake.py executed successfully!")
else:
    print(f"❌ wake.py failed with return code {result.returncode}")
