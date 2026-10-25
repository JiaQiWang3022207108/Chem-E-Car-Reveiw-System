import { writeFile } from "node:fs/promises";

const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function header(body) {
  return concat(u16(crc32(body) & 0xffff), body);
}

function fileBlock(pathname, data) {
  const name = encoder.encode(pathname);
  const body = concat(
    Uint8Array.of(0x74),
    u16(0x8000),
    u16(32 + name.length),
    u32(data.length),
    u32(data.length),
    Uint8Array.of(3),
    u32(crc32(data)),
    u32(0),
    Uint8Array.of(20, 0x30),
    u16(name.length),
    u32(0x20),
    name,
  );
  return concat(header(body), data);
}

const mainHeader = header(concat(Uint8Array.of(0x73), u16(0), u16(13), u16(0), u32(0)));
const endHeader = header(concat(Uint8Array.of(0x7b), u16(0), u16(7)));
const files = [
  ["Nanjing-Tech/Chinese-EDP.pdf", "%PDF-1.4\nsynthetic Chinese EDP fixture\n%%EOF\n"],
  ["Nanjing-Tech/English-EDP.pdf", "%PDF-1.4\nsynthetic English EDP fixture\n%%EOF\n"],
  ["Nanjing-Tech/EDP-Supplement.pdf", "%PDF-1.4\nsynthetic EDP supplement fixture\n%%EOF\n"],
  ["Nanjing-Tech/MOC.pdf", "%PDF-1.4\nsynthetic MOC fixture\n%%EOF\n"],
];
const archive = concat(
  Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00),
  mainHeader,
  ...files.map(([pathname, content]) => fileBlock(pathname, encoder.encode(content))),
  endHeader,
);

await writeFile(new URL("./nested-round2.rar", import.meta.url), archive);
