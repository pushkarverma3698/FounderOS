import { BoundingBox } from "../compose/render.js";
import { Box } from "../templates/types.js";

export function verifySafeAreaBreaches(
  slotBoxes: Record<string, BoundingBox>,
  safeArea: Box
): boolean {
  for (const box of Object.values(slotBoxes)) {
    const boxRight = box.x + box.width;
    const boxBottom = box.y + box.height;

    const safeRight = safeArea.x + safeArea.width;
    const safeBottom = safeArea.y + safeArea.height;

    if (
      box.x < safeArea.x ||
      box.y < safeArea.y ||
      boxRight > safeRight ||
      boxBottom > safeBottom
    ) {
      return true; // Breach detected
    }
  }
  return false; // Safe
}
