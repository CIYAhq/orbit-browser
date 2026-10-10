import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  type LucideIcon,
  Package,
} from 'lucide-react'
import { type DragEvent, useState } from 'react'
import { type FileKind, fileKind, isMedia } from '../../../shared/commands/downloads'
import { invoke } from '../api'

const ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  installer: Package,
  document: FileText,
  code: FileCode,
  other: File,
}

/** A file's kind as an icon (DL-05, DL-10). */
export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = ICONS[fileKind(name)]
  return <Icon size={size} strokeWidth={1.8} aria-hidden />
}

/**
 * A picture of a file (DL-05, DL-10): the image itself when it is one Orbit can show and it loads,
 * else its kind's icon.
 */
export function FileThumb({ name, url, size }: { name: string; url?: string; size: number }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed && fileKind(name) === 'image' && isMedia(name)) {
    return (
      <img
        className="file-thumb"
        data-testid="file-thumb"
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    )
  }
  return <FileIcon name={name} size={Math.round(size * 0.75)} />
}

/**
 * Drags a file out of Orbit as the file itself (DL-06), from a `dragstart`: the page's own drag is
 * cancelled and the OS's takes over, so the file drops into a page's upload field, a folder, the
 * desktop or another app. Resolves when Orbit has handed the drag over (on some systems, once the
 * file is dropped).
 */
export function dragOut(e: DragEvent, id: string): Promise<boolean> {
  e.preventDefault()
  return invoke('downloads.drag', { id })
}
