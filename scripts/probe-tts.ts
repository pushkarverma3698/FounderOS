import { synthesizeSpeech } from "../src/tools/tts.js";
const t = Date.now();
const r = await synthesizeSpeech("No entry. Exit on the right. Thanks for your visit.");
console.log("elapsed", ((Date.now()-t)/1000).toFixed(1)+"s", r.success ? "OGG bytes: " + (r as any).data.oggOpus.length : "ERR: " + (r as any).error);
