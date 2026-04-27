import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ISectionOptions,
} from "docx";
import { writeFile } from "node:fs/promises";

export function h1(text: string) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
}
export function h2(text: string) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
}
export function h3(text: string) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_3 });
}
export function h4(text: string) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_4 });
}

export function p(text: string) {
  return new Paragraph({ children: [new TextRun(text)] });
}

export function code(text: string) {
  return new Paragraph({
    children: [new TextRun({ text, font: "Courier New" })],
  });
}

export function bullet(text: string, level = 0) {
  return new Paragraph({
    text,
    bullet: { level },
  });
}

export function spacer() {
  return new Paragraph({ children: [new TextRun("")] });
}

export function note(text: string) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({ text, italics: true, color: "666666" })],
  });
}

function cell(text: string, opts?: { bold?: boolean }): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: text ?? "", bold: opts?.bold ?? false }),
        ],
      }),
    ],
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
  });
}

export function simpleTable(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h) => cell(h, { bold: true })),
  });
  const dataRows = rows.map(
    (r) =>
      new TableRow({
        children: headers.map((_, i) => cell(r[i] ?? "")),
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

export async function writeDocx(
  filePath: string,
  title: string,
  children: ISectionOptions["children"],
): Promise<void> {
  const doc = new Document({
    creator: "db-schema skill",
    title,
    description: title,
    lastModifiedBy: "db-schema skill",
    sections: [{ properties: {}, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  await writeFile(filePath, buffer);
}
