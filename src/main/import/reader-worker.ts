/**
 * The import's reader, in a worker thread (D58): a dropped or chosen file, or a list of links, is read here and not
 * on main's thread, so no file (up to the 64 MB limit) can stall the browser. Main starts one per read and ends it
 * when the answer comes (`reader.ts`). Bytes come and go moved, not copied. Imports only pure modules.
 */
import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { MAX_FILE_BYTES, TOO_LARGE } from '../../shared/commands/import'
import {
  decodeText,
  type FileRead,
  type LinksRead,
  linkNodes,
  linksInfo,
  PART_SIZE,
  parseFile,
  type ReadRequest,
} from './files'

/** The bytes in a buffer of their own, so that moving it to main moves nothing else. */
function ownBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes)
}

async function answer(request: ReadRequest): Promise<{ result: FileRead | LinksRead; move: ArrayBuffer[] }> {
  if (request.op === 'links') {
    const { nodes, lines, cut } = linkNodes(typeof request.list === 'string' ? request.list : decodeText(request.list))
    const parts: string[] = []
    for (let i = 0; i < nodes.length; i += PART_SIZE) parts.push(JSON.stringify(nodes.slice(i, i + PART_SIZE)))
    return { result: { parts, lines, cut }, move: [] }
  }
  const bytes = request.op === 'path' ? new Uint8Array(await readFile(request.path)) : request.bytes
  if (bytes.byteLength > MAX_FILE_BYTES)
    return { result: { kind: 'error', name: request.name, message: TOO_LARGE }, move: [] }
  const text = decodeText(bytes)
  // A pasted list is a list whatever it holds; a file is a bookmarks file or a list of links (IM-13).
  const read =
    request.op === 'list'
      ? { kind: 'links' as const, name: request.name, info: linksInfo(text) }
      : parseFile(request.name, text)
  if (read.kind === 'links') {
    // A list that edits well goes back as its text; a longer one as its bytes, which main holds (D62 (5)).
    if (!read.info.long) return { result: { ...read, text }, move: [] }
    const own = ownBytes(bytes)
    return { result: { ...read, bytes: own }, move: [own.buffer as ArrayBuffer] }
  }
  if (read.kind !== 'bookmarks') return { result: read, move: [] }
  // The tree as JSON text: main passes it on without reading it.
  const json = JSON.stringify(read.tree)
  return { result: { kind: 'bookmarks', name: read.name, json, count: read.count, cut: read.cut }, move: [] }
}

answer(workerData as ReadRequest).then(
  ({ result, move }) => parentPort?.postMessage({ result }, move),
  (err: unknown) => parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) }),
)
