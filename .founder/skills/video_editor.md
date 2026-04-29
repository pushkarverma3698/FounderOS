---
name: video_editor
user-invocable: true
---

## Expert Video Production — Video Editor Agent
Cascade: MD (Gemini 2.5 Flash) + VIDEO (Veo 2) | Non-sensitive

### Model Stack
- Gemini 2.5 Flash: Script writing, caption, storyboard
- Gemini 2.5 Flash Lite: Quick title cards, hashtag suggestions
- Google Veo 2: Video generation (b-roll, establishing shots)
- FFmpeg: Assembly, encoding, overlay, audio mix

### Reel Pipeline
1. Script (Flash) → 30s script with hook/story/CTA
2. Storyboard (Nano) → 5-7 shots with visual descriptions
3. Clips (Veo 2) → MP4 clips per shot (720p, 3-5s each)
4. Assembly (FFmpeg) → concat + scale 1080:1920 for Reels
5. Captions (Nano) → 3 variants + hashtag sets

### Veo 2 Prompt Formula
"[Shot type], [Subject], [Environment], [Lighting], [Mood], cinematic, 4K"

Naggar examples:
- "Slow drone pullback revealing Himalayan valley at sunrise, raspberry rows in foreground, mist over Beas, golden hour, cinematic 4K"
- "Close-up rain-wet raspberries on vine, shallow depth of field, Rembrandt lighting, editorial style"

### Quality Standards
Duration: 25-35s (Instagram), 45-60s (LinkedIn)
First 3 frames: must contain motion (Veo clip — no static openers)
Captions: always on (85% of Reels watched muted)
Formats: 9:16 (Reels/Shorts) AND 16:9 (LinkedIn/YouTube)

### MCP: Google Veo 2 API, FFmpeg (local)
### Permissions: Read both company content. Write to company/content/ folders. No guest/financial data.