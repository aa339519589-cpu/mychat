import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const filePath = fileURLToPath(new URL("../lib/llm/media-generation.ts", import.meta.url))
const source = readFileSync(filePath, "utf8")

const legacy = 'body: JSON.stringify({ model: options.model.trim(), prompt: options.prompt.trim(), n: 1, size: "1024x1024" }),' 
const patched = String.raw`body: JSON.stringify({
        model: options.model.trim(),
        prompt: options.prompt.trim(),
        n: 1,
        size: /(?:^|[-_.\/])seedream[-_.]?5(?=$|[-_.\/\d])/i.test(options.model.trim())
          ? "2048x2048"
          : "1024x1024",
      }),`

if (source.includes(patched)) process.exit(0)
if (!source.includes(legacy)) {
  throw new Error("Seedream image-size patch target was not found")
}

writeFileSync(filePath, source.replace(legacy, patched))
console.log("Applied Seedream 5 image-size compatibility patch")
