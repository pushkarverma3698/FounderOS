import { TemplateManifest, TemplateModule, RenderProps } from "../types.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const manifest: TemplateManifest = {
  id: "poster-cinematic",
  aspects: ["4:5"],
  slots: {
    headline: { role: "display", maxChars: 25, required: true },
    kicker: { role: "utility", maxChars: 30, required: true },
    subheadline: { role: "sub", maxChars: 120, required: true },
    itemCode: { role: "utility", maxChars: 20, required: false },
  },
  reserved: [],
  safeAreas: {
    content: { x: 50, y: 50, width: 980, height: 1250 },
  },
  requiredTokens: ["bg", "text", "muted", "accent"],
};

export const posterCinematicTemplate: TemplateModule = {
  manifest,
  render(props: RenderProps): string {
    const css = readFileSync(join(__dirname, "style.css"), "utf8");
    const { plateBase64, subjectBase64, copy, tokens } = props;

    // We build the HTML using a strict layer stack to achieve the "Text-Behind-Subject" effect.
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: ${tokens.palette.bg};
      --text: ${tokens.palette.text};
      --muted: ${tokens.palette.muted};
      --accent: ${tokens.palette.accent};
      
      --font-display: "${tokens.type.display.family}", sans-serif;
      --font-utility: "${tokens.type.utility.family}", sans-serif;
    }
    ${css}
  </style>
</head>
<body>
  <div class="poster-canvas">
    
    <!-- Layer 0: Original Base Plate -->
    <div class="layer layer-bg" style="background-image: url('data:image/png;base64,${plateBase64}')"></div>

    <!-- Layer 1: Huge Typography (Sandwiched) -->
    <div class="layer layer-text">
      <div class="typography-container">
        <div class="huge-headline" style="
          font-family: var(--font-display);
          font-weight: ${tokens.type.display.weight};
        ">${copy.headline || "HEADLINE"}</div>
      </div>
    </div>

    <!-- Layer 1.5: Light Wrap (Screen Blend) -->
    <div class="layer layer-lightwrap" style="background-image: url('data:image/png;base64,${plateBase64}')"></div>

    <!-- Layer 2: Isolated Subject Cutout (BiRefNet Mask) -->
    <div class="layer layer-subject" style="background-image: url('data:image/png;base64,${subjectBase64}')"></div>

    <!-- Layer 3: HUD / Technical Data & Small Copy -->
    <div class="layer layer-hud">
      
      <!-- Top HUD -->
      <div class="hud-top">
        <div class="kicker" style="font-family: var(--font-utility); font-weight: ${tokens.type.utility.weight}; letter-spacing: ${tokens.type.utility.tracking / 1000}em;">
          ${copy.kicker || "SYSTEM INIT"}
        </div>
      </div>
      
      <!-- Vertical Spine Text -->
      <div class="vertical-spine" style="font-family: var(--font-utility); letter-spacing: ${tokens.type.utility.tracking / 1000}em;">
        EXTRACT // ${new Date().getTime()} // TGT_LC: ${copy.itemCode || "P01_SEA_B1"}
      </div>

      <!-- Topographical SVG Pattern (Right Margin) -->
      <div class="topo-map">
        <svg viewBox="0 0 100 200" preserveAspectRatio="none" style="width: 100%; height: 100%;">
          <path d="M0,50 Q25,20 50,60 T100,40 M0,70 Q30,90 60,60 T100,80 M0,100 Q40,120 70,90 T100,110 M0,130 Q20,160 50,140 T100,150" fill="none" stroke="var(--muted)" stroke-width="0.5" opacity="0.3" />
        </svg>
      </div>
      
      <!-- Bottom HUD -->
      <div class="hud-bottom">
        <div class="subheadline" style="font-family: var(--font-display); font-weight: 400;">
          ${copy.subheadline || "The subheadline goes here."}
        </div>
        
        <!-- Services List -->
        <div class="services-list" style="font-family: var(--font-utility); font-weight: 700;">
          <div class="service-item">SaaS & Web App Development</div>
          <div class="service-item">UI/UX Design</div>
          <div class="service-item">AI & Software Automation</div>
          <div class="service-item">Cloud & Infrastructure</div>
        </div>

        <div class="hud-meta">
          <div class="barcode">
            <svg width="120" height="30">
              <rect x="0" y="0" width="3" height="30" fill="var(--text)" />
              <rect x="5" y="0" width="1" height="30" fill="var(--text)" />
              <rect x="8" y="0" width="4" height="30" fill="var(--text)" />
              <rect x="14" y="0" width="2" height="30" fill="var(--text)" />
              <rect x="19" y="0" width="5" height="30" fill="var(--text)" />
              <rect x="26" y="0" width="1" height="30" fill="var(--text)" />
              <rect x="30" y="0" width="8" height="30" fill="var(--text)" />
              <rect x="40" y="0" width="2" height="30" fill="var(--text)" />
              <rect x="45" y="0" width="1" height="30" fill="var(--text)" />
              <rect x="49" y="0" width="4" height="30" fill="var(--text)" />
              <rect x="55" y="0" width="2" height="30" fill="var(--text)" />
              <rect x="60" y="0" width="6" height="30" fill="var(--text)" />
              <rect x="68" y="0" width="1" height="30" fill="var(--text)" />
              <rect x="71" y="0" width="3" height="30" fill="var(--text)" />
              <rect x="76" y="0" width="2" height="30" fill="var(--text)" />
              <rect x="80" y="0" width="5" height="30" fill="var(--text)" />
              <rect x="87" y="0" width="3" height="30" fill="var(--text)" />
              <rect x="92" y="0" width="1" height="30" fill="var(--text)" />
              <rect x="95" y="0" width="4" height="30" fill="var(--text)" />
              <rect x="101" y="0" width="2" height="30" fill="var(--text)" />
              <rect x="105" y="0" width="5" height="30" fill="var(--text)" />
              <rect x="112" y="0" width="2" height="30" fill="var(--text)" />
              <rect x="116" y="0" width="4" height="30" fill="var(--text)" />
            </svg>
            <div class="item-code" style="font-family: var(--font-utility); font-weight: ${tokens.type.utility.weight}; letter-spacing: ${tokens.type.utility.tracking / 1000}em;">
              ${copy.itemCode || "ITEM_CODE: P01_SEA_B1"}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Layer 4: Analog Texture (Film Grain & Noise) -->
    <div class="layer layer-texture">
      <svg width="0" height="0">
        <filter id="grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" result="noise" />
          <feColorMatrix type="saturate" values="0" result="monoNoise" />
          <feComponentTransfer result="adjustedNoise">
            <feFuncA type="linear" slope="0.12" />
          </feComponentTransfer>
          <feBlend in="SourceGraphic" in2="adjustedNoise" mode="overlay" />
        </filter>
      </svg>
      <div class="grain-overlay" style="filter: url(#grain-filter);"></div>
    </div>

  </div>
</body>
</html>
    `;
  },
};
