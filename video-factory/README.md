# FounderOS Video Factory

Brand-config-driven social-video production. Full architecture, cost model,
retainer pricing, and roadmap: **[docs/VIDEO-FACTORY.md](../docs/VIDEO-FACTORY.md)**.

This directory is a **standalone npm workspace** (plain `npm`, NOT part of the
root pnpm workspace) so the HyperFrames toolchain never touches the kernel's
lockfile or CI.

## Layout
```
brands/                 # one dir per client — brand.json is the contract
projects/<project>/     # one dir per deliverable
  index.html            #   16:9 composition (HyperFrames, seek-safe GSAP)
  index-vertical.html   #   9:16 — separate file by design (no responsive render)
  index-square.html     #   1:1
  renders/              #   MP4 output (gitignored)
scripts/gen-broll.mjs   # Stage 2: Veo 3.1 b-roll (GEMINI_API_KEY)
scripts/gen-voiceover.mjs # Stage 2: ElevenLabs VO (ELEVENLABS_API_KEY)
```

## Setup (once per machine)
```bash
cd video-factory
npm install --ignore-scripts       # hyperframes + gsap (skips optional onnxruntime)
./node_modules/.bin/hyperframes browser ensure   # chrome-headless-shell
sudo apt-get install -y ffmpeg     # if missing
./node_modules/.bin/hyperframes doctor           # verify
```

## Produce a video
```bash
cd projects/<project>
HF=../../node_modules/.bin/hyperframes
$HF lint && $HF check                                   # MUST pass before render
$HF render -o renders/<name>-16x9.mp4 --quality standard
$HF render -c index-vertical.html -o renders/<name>-9x16.mp4 --quality standard
$HF render -c index-square.html  -o renders/<name>-1x1.mp4  --quality standard
```

Draft iteration: `--quality draft` (~3× faster). QA frames:
`ffmpeg -ss <t> -i render.mp4 -frames:v 1 qa.jpg`.
