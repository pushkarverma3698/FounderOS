import { RenderProps, TemplateModule } from "../types.js";
import { manifest } from "./manifest.js";

export const posterQuietTemplate: TemplateModule = {
  manifest,
  render(props: RenderProps): string {
    const {
      layer = "full",
      tokens,
      copy,
      plateBase64 = "",
      width = 1080,
      height = 1350,
    } = props;

    const palette = tokens?.palette || {};
    const bg = palette.bg || "#0d130e";
    const text = palette.text || "#ffffff";
    const muted = palette.muted || "#a0aab0";
    const accent = tokens?.accent || "#ff5c47";

    const displayFamily = tokens?.type?.display?.family || "system-ui, -apple-system, sans-serif";
    const displayWeight = tokens?.type?.display?.weight || 800;
    const displayTracking = tokens?.type?.display?.tracking || -0.028;

    const utilityFamily = tokens?.type?.utility?.family || "monospace, Courier New";

    const isMask = layer === "mask";
    const isPlate = layer === "plate";

    const plateCss = plateBase64
      ? `background-image: url('data:image/png;base64,${plateBase64}');`
      : `background-color: ${bg};`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${width}, height=${height}, initial-scale=1.0">
  <title>Poster Quiet</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      font-family: ${displayFamily};
      background: ${isMask ? "#000000" : bg};
      color: ${isMask ? "#ffffff" : text};
    }
    .post {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 60px;
      ${isMask ? "background: #000000;" : plateCss}
      background-size: cover;
      background-position: center;
    }

    /* Dual gradient scrims */
    .scrim-top {
      position: absolute;
      top: 0; left: 0; right: 0; height: 50%;
      background: linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0) 100%);
      pointer-events: none;
      display: ${isMask ? "none" : "block"};
    }
    .scrim-bottom {
      position: absolute;
      bottom: 0; left: 0; right: 0; height: 45%;
      background: linear-gradient(0deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0) 100%);
      pointer-events: none;
      display: ${isMask ? "none" : "block"};
    }

    .content-top {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 16px;
      opacity: ${isPlate ? 0 : 1};
    }
    .kicker {
      font-family: ${utilityFamily};
      font-size: 20px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: ${isMask ? "#ffffff" : muted};
    }
    .headline {
      font-size: 72px;
      font-weight: ${displayWeight};
      line-height: 1.05;
      letter-spacing: ${displayTracking}em;
      text-transform: uppercase;
      color: ${isMask ? "#ffffff" : text};
    }
    .subheadline {
      font-size: 24px;
      line-height: 1.4;
      color: ${isMask ? "#ffffff" : muted};
      max-width: 80%;
      margin-top: 8px;
    }

    .content-bottom {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 24px;
      opacity: ${isPlate ? 0 : 1};
    }
    .meta-rail {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      font-family: ${utilityFamily};
      font-size: 22px;
      border-top: 1px solid ${isMask ? "#ffffff" : "rgba(255,255,255,0.2)"};
      padding-top: 20px;
      color: ${isMask ? "#ffffff" : text};
    }
    .meta-left {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .price-tag {
      font-size: 38px;
      font-weight: 700;
      color: ${isMask ? "#ffffff" : text};
      text-align: right;
    }
    .cta-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background-color: ${isMask ? "#ffffff" : accent};
      color: ${isMask ? "#000000" : "#ffffff"};
      padding: 22px 32px;
      border-radius: 40px;
      font-weight: 800;
      font-size: 22px;
      letter-spacing: 0.05em;
    }
    .cta-url {
      font-family: ${utilityFamily};
      font-size: 18px;
      font-weight: 500;
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="post">
    <div class="scrim-top"></div>
    <div class="scrim-bottom"></div>

    <div class="content-top">
      ${copy.kicker ? `<div class="kicker" data-slot="kicker">${copy.kicker}</div>` : ""}
      <div class="headline" data-slot="headline">${copy.headline || ""}</div>
      ${copy.subheadline ? `<div class="subheadline" data-slot="subheadline">${copy.subheadline}</div>` : ""}
    </div>

    <div class="content-bottom">
      <div class="meta-rail">
        <div class="meta-left">
          <div data-slot="dateVenue">${copy.dateVenue || ""}</div>
        </div>
        ${copy.price ? `<div class="price-tag" data-slot="price">${copy.price}</div>` : ""}
      </div>
      <div class="cta-bar">
        <div data-slot="cta">${copy.cta || "REGISTER NOW"}</div>
        ${copy.url ? `<div class="cta-url" data-slot="url">${copy.url}</div>` : ""}
      </div>
    </div>
  </div>
</body>
</html>`;
  },
};
