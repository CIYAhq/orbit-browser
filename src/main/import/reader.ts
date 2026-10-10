/// <reference types="electron-vite/node" />
/**
 * Reading a dropped or chosen file, or a list of links, in a worker thread (D58): main's thread only passes text on.
 * Each read has its own worker, ended when it answers, fails or takes too long, and at quit.
 */
import type { Worker } from 'node:worker_threads'
import type { BookmarkNode } from '../../shared/commands/import'
import type { FileRead, LinksRead, ReadRequest } from './files'
import startReader from './reader-worker?nodeWorker'

/** A read that takes longer than this is stopped (a 64 MB file takes a few seconds). */
const TIMEOUT_MS = 60_000
export const UNREADABLE = 'Orbit couldn’t read this file'

const running = new Set<Worker>()

/** Bytes are moved to the worker, not copied (D62 (5)): only when they're the whole of their buffer. */
function moved(request: ReadRequest): ArrayBuffer[] {
  const bytes = 'bytes' in request ? request.bytes : request.op === 'links' ? request.list : undefined
  if (!(bytes instanceof Uint8Array) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength)
    return []
  return [bytes.buffer as ArrayBuffer]
}

function read<T>(request: ReadRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = startReader({ workerData: request, transferList: moved(request) })
    running.add(worker)
    const end = (settle: () => void) => {
      if (!running.delete(worker)) return
      clearTimeout(timer)
      void worker.terminate()
      settle()
    }
    const timer = setTimeout(() => end(() => reject(new Error('Reading took too long'))), TIMEOUT_MS)
    timer.unref()
    worker.once('message', (m: { result?: T; error?: string }) =>
      end(() => (m.error === undefined ? resolve(m.result as T) : reject(new Error(m.error)))),
    )
    worker.once('error', (err) => end(() => reject(err)))
    worker.once('exit', () => end(() => reject(new Error('Reading stopped'))))
  })
}

/**
 * A dropped file, the file at `path` or a pasted list, read: its bookmarks (as JSON), its links, or why it can't be read.
 * The bytes go to the worker: after this call they're no longer main's.
 */
export async function readFileOffMain(
  request: Extract<ReadRequest, { op: 'file' | 'path' | 'list' }>,
): Promise<FileRead> {
  try {
    return await read<FileRead>(request)
  } catch {
    return { kind: 'error', name: request.name, message: UNREADABLE }
  }
}

/**
 * A list of links as bookmarks (IM-12): its text, or the bytes main held (moved to the worker). Main reads the worker's
 * answer a part at a time, a turn apart.
 */
export async function readLinksOffMain(
  list: string | Uint8Array,
): Promise<{ nodes: BookmarkNode[]; lines: number; cut: number }> {
  const { parts, lines, cut } = await read<LinksRead>({ op: 'links', list })
  const nodes: BookmarkNode[] = []
  for (const part of parts) {
    for (const node of JSON.parse(part) as BookmarkNode[]) nodes.push(node)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { nodes, lines, cut }
}

/** Quit: ends every read; each one's caller sees it stop. */
export function stopReaders(): void {
  for (const worker of running) void worker.terminate()
}
