"""
FounderOS — Video Editor Agent (Reel Maker)
=============================================
A cross-company specialist that produces Reels and short-form videos
for both Turicks (case study / explainer videos) and Naggar (farm vibe content).

Pipeline:
  MD request → Script (Gemini Flash) → Storyboard (Gemini Nano) 
  → Shots (Veo 2) → Assembly (FFmpeg) → Captions (Gemini Nano)  
  → Saved to content/ folder → Notification to Telegram

Requires:
  - GOOGLE_API_KEY with Veo 2 access
  - FFmpeg installed (brew install ffmpeg)
  - Pollinations.ai as free Veo fallback if quota exceeded
"""

import os, sys, asyncio, logging, httpx, subprocess
from pathlib import Path
sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import GOOGLE_API_KEY, TURICKS_DIR, NAGGAR_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOPIC_TURICKS, TOPIC_NAGGAR, call_md, call_nano
from utils.skill_library import VIDEO_EDITOR_MASTERY

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("VideoEditor")


# ─── Output directories ───────────────────────────────────────────────────────
TURICKS_CONTENT = TURICKS_DIR / "content"
NAGGAR_CONTENT  = NAGGAR_DIR  / "content"
TURICKS_CONTENT.mkdir(exist_ok=True)
NAGGAR_CONTENT.mkdir(exist_ok=True)


# ─── Step 1: Generate Script ──────────────────────────────────────────────────
def generate_script(topic: str, company: str, duration: int = 30) -> str:
    """Gemini Flash writes a short-form video script."""
    prompt = f"""You are an expert video scriptwriter for {company}.

Topic: {topic}
Duration: {duration} seconds
Format: Instagram Reel / LinkedIn Short

Write a tight video script following this structure:
- HOOK (0-3s): Bold opening statement or unexpected visual cue
- STORY (3-{duration-8}s): Core narrative with atmosphere and specific details
- VALUE ({duration-8}-{duration-3}s): The key takeaway or insight
- CTA (last 3s): One specific action

Include:
- [VOICEOVER]: text spoken aloud
- [ON-SCREEN TEXT]: text displayed on screen  
- [VISUAL]: description of what's shown

{VIDEO_EDITOR_MASTERY.split('### Reel Production Pipeline')[0]}

Output only the script, no meta-commentary."""

    resp = call_md(prompt)
    return resp


# ─── Step 2: Generate Shot List ──────────────────────────────────────────────
def generate_storyboard(script: str, company: str) -> list[dict]:
    """Gemini Nano (fast) converts script to a Veo 2-ready shot list."""
    prompt = f"""You are a cinematographer converting this script into a precise shot list for AI video generation.

Company: {company}
Script:
{script}

Generate 5-7 shots. For each shot output this JSON:
{{"shot": <number>, "duration": <seconds>, "veo_prompt": "<cinematic Veo 2 prompt>", 
  "on_screen_text": "<overlay text or empty>", "voiceover": "<narration text or empty>"}}

Veo 2 prompt format: "[Camera angle], [Subject], [Environment], [Lighting], [Mood], cinematic, 4K"

Return a JSON array only. No markdown."""

    resp = call_nano(prompt)
    try:
        import json
        from json_repair import repair_json
        return repair_json(resp, return_objects=True)
    except Exception:
        log.error("Storyboard parse failed.")
        return []


# ─── Step 3: Generate Video via Veo 2 (with Pollinations fallback) ────────────
async def generate_shot_video(veo_prompt: str, shot_num: int, output_dir: Path) -> Path | None:
    """
    Calls Google Veo 2 API to generate a video clip.
    Falls back to Pollinations.ai image → FFmpeg video if Veo unavailable.
    """
    output_path = output_dir / f"shot_{shot_num:02d}.mp4"

    # ── Try Veo 2 via Google AI Studio API ────────────────────────────────────
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning",
                headers={"x-goog-api-key": GOOGLE_API_KEY, "Content-Type": "application/json"},
                json={"instances": [{"prompt": veo_prompt}],
                      "parameters": {"aspectRatio": "9:16", "sampleCount": 1}}
            )
            if resp.status_code == 200:
                data = resp.json()
                # Poll the long-running operation
                op_name = data.get("name", "")
                if op_name:
                    video_bytes = await poll_veo_operation(op_name)
                    if video_bytes:
                        output_path.write_bytes(video_bytes)
                        log.info(f"  Shot {shot_num}: Veo 2 ✅ → {output_path.name}")
                        return output_path
    except Exception as e:
        log.warning(f"  Shot {shot_num}: Veo 2 unavailable ({e}). Using Pollinations fallback.")

    # ── Fallback: Pollinations image → 3-second video loop ───────────────────
    return await pollinations_fallback(veo_prompt, shot_num, output_dir)


async def poll_veo_operation(op_name: str, max_polls: int = 20) -> bytes | None:
    """Poll a Veo 2 long-running operation until complete."""
    async with httpx.AsyncClient(timeout=30) as client:
        for _ in range(max_polls):
            await asyncio.sleep(6)
            resp = await client.get(
                f"https://generativelanguage.googleapis.com/v1beta/{op_name}",
                headers={"x-goog-api-key": GOOGLE_API_KEY}
            )
            data = resp.json()
            if data.get("done"):
                videos = data.get("response", {}).get("predictions", [])
                if videos and "bytesBase64Encoded" in videos[0]:
                    import base64
                    return base64.b64decode(videos[0]["bytesBase64Encoded"])
    return None


async def pollinations_fallback(prompt: str, shot_num: int, output_dir: Path) -> Path | None:
    """Generate an image from Pollinations.ai and loop it into a 3s video with FFmpeg."""
    import urllib.parse
    img_path = output_dir / f"shot_{shot_num:02d}.jpg"
    out_path  = output_dir / f"shot_{shot_num:02d}.mp4"
    safe      = urllib.parse.quote(prompt[:200])

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(f"https://image.pollinations.ai/prompt/{safe}?width=1080&height=1920&nologo=true")
            img_path.write_bytes(resp.content)

        # Loop image into 3-second video
        subprocess.run([
            "ffmpeg", "-y", "-loop", "1", "-i", str(img_path),
            "-t", "3", "-vf", "scale=1080:1920,setsar=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out_path)
        ], capture_output=True, check=True)
        log.info(f"  Shot {shot_num}: Pollinations fallback ✅ → {out_path.name}")
        return out_path
    except Exception as e:
        log.error(f"  Shot {shot_num}: Fallback failed: {e}")
        return None


# ─── Step 4: Assemble Reel ────────────────────────────────────────────────────
def assemble_reel(shot_paths: list[Path], output_dir: Path, title: str) -> Path | None:
    """Concatenate all shots into a final Reel using FFmpeg."""
    if not shot_paths:
        return None

    concat_file = output_dir / "concat.txt"
    concat_file.write_text("\n".join(f"file '{p}'" for p in shot_paths if p and p.exists()))

    safe_title = title.replace(" ", "_")[:40]
    out_path   = output_dir / f"reel_{safe_title}.mp4"

    try:
        subprocess.run([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(concat_file),
            "-vf", "scale=1080:1920,setsar=1",
            "-c:v", "libx264", "-c:a", "aac",
            str(out_path)
        ], capture_output=True, check=True)
        log.info(f"✅ Reel assembled: {out_path}")
        return out_path
    except subprocess.CalledProcessError as e:
        log.error(f"FFmpeg failed: {e.stderr.decode()}")
        return None


# ─── Step 5: Generate Captions ────────────────────────────────────────────────
def generate_captions(topic: str, company: str) -> str:
    """Gemini Nano generates 3 caption variants + hashtag set."""
    prompt = f"""You are a social media expert for {company}.
Topic: {topic}

Write 3 caption variants for this Reel:
1. Short & punchy (< 50 chars)
2. Story-driven (100-150 chars)
3. Value-driven (150-200 chars + 5 hashtags)

Format each as:
CAPTION_1: [text]
CAPTION_2: [text]
CAPTION_3: [text]
HASHTAGS: #tag1 #tag2 #tag3 #tag4 #tag5"""

    resp = call_nano(prompt)
    return resp


# ─── Main Entrypoint ──────────────────────────────────────────────────────────
async def produce_reel(topic: str, company: str = "naggar", duration: int = 30) -> dict:
    """
    Full end-to-end Reel production pipeline.
    Returns dict with script, captions, and output file path.
    """
    output_dir = NAGGAR_CONTENT if company == "naggar" else TURICKS_CONTENT
    log.info(f"🎬 Starting reel production: '{topic}' ({company})")

    # 1. Script
    script = generate_script(topic, company, duration)
    log.info("  Script ✅")

    # 2. Storyboard
    shots  = generate_storyboard(script, company)
    log.info(f"  Storyboard: {len(shots)} shots ✅")

    # 3. Generate video clips
    shot_paths = []
    for shot in shots:
        path = await generate_shot_video(shot.get("veo_prompt", ""), shot.get("shot", 0), output_dir)
        shot_paths.append(path)

    # 4. Assemble
    final_reel = assemble_reel([p for p in shot_paths if p], output_dir, topic)

    # 5. Captions
    captions = generate_captions(topic, company)

    return {
        "script":   script,
        "shots":    len(shots),
        "captions": captions,
        "reel_path": str(final_reel) if final_reel else None,
        "status":   "✅ Complete" if final_reel else "⚠️ Assembly failed"
    }


if __name__ == "__main__":
    result = asyncio.run(produce_reel(
        topic="Raspberry harvest at Naggar — golden hour",
        company="naggar",
        duration=30
    ))
    print(result)
