import asyncio
from mac_client.profile import load_profile

print("Testing Pushkar's profile...")
try:
    p1 = load_profile(profile_override={"profile_id": "pushkar-nl-tech", "candidateName": "Pushkar", "candidateEmail": "p@p.com", "candidatePhone": "123", "tracks": {}})
    print(p1)
except Exception as e:
    print("Pushkar Profile Error:", e)

print("Testing Tashi's profile...")
try:
    p2 = load_profile(profile_override={"profile_id": "wife-nl-finance", "candidateName": "Tashi", "candidateEmail": "t@t.com", "candidatePhone": "123", "tracks": {}})
    print(p2)
except Exception as e:
    print("Tashi Profile Error:", e)
