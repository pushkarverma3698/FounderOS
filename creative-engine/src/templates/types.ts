import { DesignTokens } from "../contracts/schemas.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReservedRegion {
  region: "top" | "bottom" | "left" | "right" | "center";
  extent: number; // 0..1
  reason: string;
}

export interface TemplateSlot {
  role: "display" | "sub" | "utility" | "cta" | "logo";
  maxChars: number;
  required: boolean;
}

export interface TemplateManifest {
  id: string;
  aspects: ("4:5" | "1:1" | "9:16")[];
  slots: Record<string, TemplateSlot>;
  reserved: ReservedRegion[];
  safeAreas: Record<string, Box>;
  requiredTokens: string[];
}

export interface RenderProps {
  layer: "full" | "plate" | "mask";
  tokens: DesignTokens;
  copy: Record<string, string>;
  plateBase64?: string;
  width?: number;
  height?: number;
}

export interface TemplateModule {
  manifest: TemplateManifest;
  render(props: RenderProps): string;
}
