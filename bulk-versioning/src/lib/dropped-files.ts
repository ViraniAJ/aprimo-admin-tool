"use client"

// Reads files out of a drag-and-drop, including whole folders. Browsers hand
// a dropped folder over as a directory entry, not as files, so it has to be
// walked with the File System entries API. Entries must be captured during
// the drop event itself; the walk can then continue asynchronously.

export interface PickedFile {
  file: File
  /** Path inside the dropped folder, e.g. "Headshots/2026/albin.jpg"; the bare name for loose files. */
  relativePath: string
}

type Entry = FileSystemEntry
type DirEntry = FileSystemDirectoryEntry
type FileEntry = FileSystemFileEntry

function readFile(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

// readEntries returns at most ~100 entries per call, so keep reading until empty.
async function readAll(dir: DirEntry): Promise<Entry[]> {
  const reader = dir.createReader()
  const out: Entry[] = []
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    out.push(...batch)
  }
  return out
}

async function walk(entry: Entry, prefix: string, out: PickedFile[]) {
  if (entry.isFile) {
    try {
      const file = await readFile(entry as FileEntry)
      out.push({ file, relativePath: prefix + file.name })
    } catch {
      /* unreadable file: skip */
    }
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry as DirEntry)) await walk(child, `${prefix}${entry.name}/`, out)
  }
}

/** Every file in a drop, walking into folders. Falls back to the flat file list when entries are unavailable. */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: Entry[] = []
  const loose: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
    else {
      const f = item.getAsFile()
      if (f) loose.push(f)
    }
  }
  if (!entries.length && !loose.length) return Array.from(dt.files ?? []).map((file) => ({ file, relativePath: file.name }))
  const out: PickedFile[] = loose.map((file) => ({ file, relativePath: file.name }))
  for (const e of entries) await walk(e, "", out)
  return out
}

/** Files from an <input type="file">, keeping the folder path when the folder picker was used. */
export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list).map((file) => ({ file, relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
}

/** Skips folders' hidden files (.DS_Store, Thumbs.db) and empty files. */
export function isUsable(f: PickedFile): boolean {
  const name = f.file.name
  return f.file.size > 0 && !name.startsWith(".") && name.toLowerCase() !== "thumbs.db" && name.toLowerCase() !== "desktop.ini"
}
