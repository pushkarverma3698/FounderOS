"""
LinkedIn OAuth2 One-Time Setup
================================
Run this ONCE to get your access token and person URN.

Usage:
    cd .c-suite && python tools/linkedin_oauth_setup.py

Prerequisites:
    1. Go to https://developer.linkedin.com/ → Create App
    2. App name: "FounderOS Social"
    3. Add Products: "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect"
    4. Set Redirect URI: http://localhost:8000/callback
    5. Add CLIENT_ID + CLIENT_SECRET to .env first
    6. Then run this script
"""
import os, sys, webbrowser, json
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"), override=True)

try:
    import httpx
except ImportError:
    print("Installing httpx...")
    os.system(f"{sys.executable} -m pip install httpx -q")
    import httpx

CLIENT_ID     = os.getenv("LINKEDIN_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("LINKEDIN_CLIENT_SECRET", "")
REDIRECT_URI  = "http://localhost:8000/callback"
SCOPE         = "openid profile email w_member_social"

if not CLIENT_ID or not CLIENT_SECRET:
    print("❌  LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set in .env first.")
    print("    Get them from: https://developer.linkedin.com/")
    sys.exit(1)

auth_url = (
    f"https://www.linkedin.com/oauth/v2/authorization"
    f"?response_type=code"
    f"&client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&scope={SCOPE.replace(' ', '%20')}"
)

code_holder: dict = {}


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        code_holder["code"] = params.get("code", [None])[0]
        code_holder["error"] = params.get("error", [None])[0]
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"<h2>Auth complete. Close this tab and return to terminal.</h2>")

    def log_message(self, fmt, *args):  # silence access log
        pass


print("=" * 60)
print("LinkedIn OAuth2 Setup")
print("=" * 60)
print(f"\nOpening browser for LinkedIn authorization...")
print(f"If it doesn't open, paste this URL:\n{auth_url}\n")
webbrowser.open(auth_url)

print("Waiting for callback on http://localhost:8000 ...")
server = HTTPServer(("", 8000), _Handler)
server.handle_request()

if code_holder.get("error"):
    print(f"\n❌  Auth error: {code_holder['error']}")
    sys.exit(1)

code = code_holder.get("code")
if not code:
    print("\n❌  No authorization code received.")
    sys.exit(1)

print("✅  Authorization code received. Exchanging for access token...")

token_resp = httpx.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    data={
        "grant_type":    "authorization_code",
        "code":          code,
        "redirect_uri":  REDIRECT_URI,
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    },
    timeout=30,
).json()

access_token = token_resp.get("access_token")
if not access_token:
    print(f"\n❌  Token exchange failed: {token_resp}")
    sys.exit(1)

# Get profile via OpenID Connect userinfo endpoint
profile_resp = httpx.get(
    "https://api.linkedin.com/v2/userinfo",
    headers={"Authorization": f"Bearer {access_token}"},
    timeout=15,
).json()

# OpenID Connect returns: sub, name, given_name, family_name, email, picture
# sub is the member ID — used to build the URN
person_id = profile_resp.get("sub", "")
name = profile_resp.get("name", "") or f"{profile_resp.get('given_name','')} {profile_resp.get('family_name','')}".strip()
if not name:
    name = "(profile name not returned)"

print("\n" + "=" * 60)
print("✅  Success! Add these to your .env file:")
print("=" * 60)
print(f"\nLINKEDIN_ACCESS_TOKEN={access_token}")
print(f"LINKEDIN_PERSON_URN=urn:li:person:{person_id}")
print(f"\n   Profile: {name} (id: {person_id})")
print(f"   Token expires in: {token_resp.get('expires_in', 'unknown')} seconds")
print(f"   Scope granted: {token_resp.get('scope', 'unknown')}")
print("\n" + "=" * 60)

# Optionally auto-write to .env
env_path = os.path.join(os.path.dirname(__file__), "../.env")
if os.path.exists(env_path):
    with open(env_path, "r") as f:
        env_content = f.read()

    updated = False
    for key, val in [
        ("LINKEDIN_ACCESS_TOKEN", access_token),
        ("LINKEDIN_PERSON_URN", f"urn:li:person:{person_id}"),
    ]:
        if f"{key}=" in env_content:
            import re
            env_content = re.sub(rf"^{key}=.*$", f"{key}={val}", env_content, flags=re.M)
            updated = True
        else:
            env_content += f"\n{key}={val}"
            updated = True

    if updated:
        with open(env_path, "w") as f:
            f.write(env_content)
        print("\n✅  .env updated automatically.")
    else:
        print("\n⚠️  Could not auto-update .env. Copy the values above manually.")
