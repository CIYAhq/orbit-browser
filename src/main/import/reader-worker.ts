/**
 * The import's reader, in a worker thread (D58): a dropped or chosen file, or a list of links, is read here and not
 * on main's thread, so no file (up to the 64 MB limit) can stall the browser. Main starts one per read and ends it
 * when the answer comes (`reader.ts`). Imports only pure modules.
 */
import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import type { ParsedFile } from '../../shared/commands/import'
import { type LinksRead, linkNodes, PART_SIZE, parseFile, type ReadRequest } from './files'

async function answer(request: ReadRequest): Promise<ParsedFile | LinksRead> {
  if (request.op === 'links') {
    const { nodes, lines, cut } = linkNodes(request.text)
    const parts: string[] = []
    for (let i = 0; i < nodes.length; i += PART_SIZE) parts.push(JSON.stringify(nodes.slice(i, i + PART_SIZE)))
    return { parts, lines, cut }
  }
  const text = request.op === 'path' ? await readFile(request.path, 'utf8') : request.text
  const read = parseFile(request.name, text)
  if (read.kind !== 'bookmarks') return read
  // The tree as JSON text: main passes it on without reading it.
  return { kind: 'bookmarks', name: read.name, json: JSON.stringify(read.tree), count: read.count, cut: read.cut }
}

answer(workerData as ReadRequest).then(
  (result) => parentPort?.postMessage({ result }),
  (err: unknown) => parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) }),
)
