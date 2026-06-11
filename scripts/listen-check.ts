import { readFileSync } from "node:fs";
import { oggToWav } from "../src/infra/media-convert.js";
import { transcribeAudio } from "../src/tools/transcription.js";
const wav = await oggToWav(readFileSync("/tmp/reply_voice.ogg"));
const r = await transcribeAudio(wav);
console.log(JSON.stringify(r, null, 2));
