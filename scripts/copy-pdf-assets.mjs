import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve("pdfjs-dist/package.json"));
const target = path.resolve("public/pdfjs");
await mkdir(target, { recursive: true });
await cp(path.join(source, "legacy/build/pdf.worker.min.mjs"), path.join(target, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
  await cp(path.join(source, dir), path.join(target, dir), { recursive: true });
}
const { version } = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
await writeFile(path.join(target, "version.json"), JSON.stringify({ version }));
console.log(`PDF.js ${version}: local worker and font assets ready`);
