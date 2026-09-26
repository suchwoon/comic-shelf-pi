// Small original vector fixture for integration tests. Never inserted into the real library.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2] || "/tmp/comic-shelf-test.pdf";
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
pdf.setTitle("A quiet afternoon");
pdf.setAuthor("Comic Shelf test fixture");
for (let i = 1; i <= 8; i++) {
  const page = pdf.addPage(i === 4 ? [880, 620] : [440, 620]);
  const { width, height } = page.getSize();
  page.drawRectangle({ width, height, color: rgb(.95, .94, .88) });
  page.drawText(i === 1 ? "A QUIET" : "THE LITTLE THINGS", { x: 34, y: height - 75, size: i === 1 ? 38 : 23, font: bold, color: rgb(.17, .29, .23) });
  if (i === 1) page.drawText("AFTERNOON", { x: 34, y: height - 122, size: 38, font: bold, color: rgb(.17, .29, .23) });
  page.drawText(`A story in eight pages / ${String(i).padStart(2, "0")}`, { x: 35, y: height - 155, size: 11, font, color: rgb(.4, .45, .38) });
  for (let j = 0; j < 3; j++) {
    const y = 85 + j * 110;
    page.drawRectangle({ x: 34, y, width: width - 68, height: 94, borderColor: rgb(.21,.32,.25), borderWidth: 2, color: rgb(.86 - j * .03, .89 - j * .02, .80) });
    page.drawCircle({ x: width - 90 - j * 25, y: y + 48, size: 27, color: rgb(.70, .74, .57) });
    page.drawLine({ start: {x: 34, y: y + 20}, end: {x: width - 34, y: y + 20}, thickness: 1.5, color: rgb(.21,.32,.25) });
  }
  page.drawText(`${i} / 8`, { x: width - 63, y: 28, size: 10, font, color: rgb(.21,.32,.25) });
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, await pdf.save());
console.log(output);
