import { readUnicodeArchive } from "./sevenzip-runtime";
import {
  openEdpArchiveCore,
  type OpenedEdpArchive,
} from "./edp-archive-core";

export async function openEdpArchive(bytes: Uint8Array, filename: string): Promise<OpenedEdpArchive> {
  return openEdpArchiveCore(bytes, filename, { readLibarchiveEntries: readUnicodeArchive });
}

export type { EdpArchiveFormat, EdpArchiveEntry, OpenedEdpArchive } from "./edp-archive-core";
export { EdpArchiveError } from "./edp-archive-core";
