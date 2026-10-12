// Index the bundled starter sound library in public/sounds.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const soundsDir = fileURLToPath(new URL("../public/sounds/", import.meta.url));
const sounds = readdirSync(soundsDir)
  .filter((f) => f.endsWith(".mp3"))
  .sort()
  .map((file) => ({ file, name: file.replace(/\.mp3$/, ""), size: statSync(join(soundsDir, file)).size }));
writeFileSync(join(soundsDir, "index.json"), JSON.stringify(sounds, null, 2));

console.log(`synced ${sounds.length} sounds into public/`);
