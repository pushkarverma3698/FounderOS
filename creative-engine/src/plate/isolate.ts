import fs from "node:fs";
import path from "node:path";

export interface IsolateOptions {
  platePath: string;
  dataDir?: string;
  apiKey?: string;
}

export interface IsolateResult {
  maskPath: string;
}

/**
 * Extracts the main subject from a background plate using Fal.ai BiRefNet.
 * Returns the path to the transparent PNG mask.
 */
export async function isolateSubject(opts: IsolateOptions): Promise<IsolateResult> {
  const dataDir = opts.dataDir || "./runs/masks";
  fs.mkdirSync(dataDir, { recursive: true });

  const fileName = path.basename(opts.platePath, path.extname(opts.platePath));
  const maskPath = path.join(dataDir, `${fileName}_mask.png`);

  if (fs.existsSync(maskPath)) {
    console.log(`[BiRefNet] Found cached mask: ${maskPath}`);
    return { maskPath };
  }

  const apiKey = opts.apiKey || process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error("FAL_KEY is required for subject isolation.");
  }

  console.log(`[BiRefNet] Uploading plate for subject isolation...`);
  
  // Read image and convert to data URI
  const imageBuffer = fs.readFileSync(opts.platePath);
  const dataUri = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  console.log(`[BiRefNet] Calling fal-ai/birefnet...`);
  const response = await fetch("https://fal.run/fal-ai/birefnet", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: dataUri,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Fal.ai API error (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  const imgUrl = data.image?.url;
  
  if (!imgUrl) {
    throw new Error(`Fal.ai returned valid response but missing image URL: ${JSON.stringify(data)}`);
  }

  console.log(`[BiRefNet] Isolation successful! Fetching mask bytes from ${imgUrl}`);
  const imgRes = await fetch(imgUrl);
  const arrayBuffer = await imgRes.arrayBuffer();
  fs.writeFileSync(maskPath, Buffer.from(arrayBuffer));

  return { maskPath };
}
