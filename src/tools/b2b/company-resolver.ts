import fs from "fs/promises";

export async function readCleanCompanyNames(filePath: string): Promise<string[]> {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return data.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("Company") && !line.includes(","));
  } catch (error) {
    console.warn(`Could not read ${filePath}, returning mock data...`);
    return ["Stripe", "Vercel", "DeepMind"];
  }
}
