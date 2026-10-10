import { Play } from 'lucide-react'
import { type MouseEvent, memo, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryFile } from '../../../shared/commands/downloads'
import { invoke } from '../api'
import { dayLabel } from '../library/geometry'
import { libraryToast } from '../library/LibraryToasts'
import type { LibrarySectionProps } from '../library/sections'
import { useOrbit, useWindow } from '../store'
import { prefersReducedMotion } from '../theme'
import { dragOut } from './file-ui'
import { byDay } from './format'
import './downloads-library.css'

/** Changes to the list come in bursts: read it once they settle. */
const RELOAD_DELAY_MS = 80

/** The Media section's files (DL-11), read again when they change and on each open of the Library. */
function useMediaFiles(profileId: string, nonce: number, screenshots: boolean): LibraryFile[] | null {
  const [files, setFiles] = useState<{ key: string; list: LibraryFile[] } | null>(null)
  const key = `${profileId}|${screenshots}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again on each open (nonce)
  useEffect(() => {
    if (!profileId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let asked = 0
    const read = () => {
      const ask = ++asked
      void invoke('downloads.media', { profileId }).then((list) => {
        if (alive && ask === asked) setFiles({ key, list })
      })
    }
    read()
    const off = window.orbit.on('downloads.changed', (payload) => {
      if ((payload as { profileId?: string }).profileId !== profileId) return
      clearTimeout(timer)
      timer = setTimeout(read, RELOAD_DELAY_MS)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [key, profileId, nonce])
  return files && files.key === key ? files.list : null
}

/** A video tile plays, muted and looping, while it is on screen; with reduced motion it stays still. */
function VideoPreview({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video || prefersReducedMotion()) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => {})
        else video.pause()
      },
      { threshold: 0.25 },
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [])
  return (
    <video
      ref={ref}
      className="dl-media__picture"
      data-testid="media-video"
      src={url}
      muted
      loop
      playsInline
      preload="metadata"
      disablePictureInPicture
      draggable={false}
    />
  )
}

const Tile = memo(function Tile({
  file,
  onOpen,
}: {
  file: LibraryFile
  onOpen: (file: LibraryFile, tab: boolean) => void
}) {
  const [broken, setBroken] = useState(false)
  return (
    <button
      type="button"
      className={`dl-media__tile${broken ? ' is-broken' : ''}`}
      data-testid="media-tile"
      data-id={file.id}
      data-kind={file.kind}
      data-source={file.source}
      title={file.name}
      draggable
      onDragStart={(e) => void dragOut(e, file.id)}
      onClick={(e: MouseEvent) => onOpen(file, e.metaKey || e.ctrlKey)}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('downloads.menu', { id: file.id })
      }}
    >
      {file.kind === 'video' ? (
        <>
          <VideoPreview url={file.url} />
          <span className="dl-media__badge" aria-hidden>
            <Play size={11} fill="currentColor" />
          </span>
        </>
      ) : (
        <img
          className="dl-media__picture"
          data-testid="media-image"
          src={file.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
        />
      )}
      <span className="dl-media__name">{file.name}</span>
    </button>
  )
})

/**
 * The Media section of the Library (DL-11): a grid of the images and videos downloaded in the
 * current Space's profile, newest first by day, and the OS's screenshots when the Library button's
 * menu shows them. Videos play silently while on screen. A tile opens a larger preview (a Peek over
 * the Library; ⌘/Ctrl-click: a new tab) and drags out as the file (DL-06).
 */
export function MediaSection({ show }: LibrarySectionProps) {
  const win = useWindow()
  const profileId = useOrbit((s) => (win ? s.spaces[win.spaceId]?.profileId : undefined)) ?? ''
  const screenshots = useOrbit((s) => s.settings.libraryScreenshots)
  const files = useMediaFiles(profileId, show.nonce, screenshots)
  const days = useMemo(() => {
    const list = files ?? []
    let at = 0
    return byDay(list.map((f) => f.at)).map(([day, count]) => {
      const group = list.slice(at, at + count)
      at += count
      return { day, files: group }
    })
  }, [files])
  const scrollerRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the newest on each fresh open
  useEffect(() => {
    if (show.entering) scrollerRef.current?.scrollTo({ top: 0 })
  }, [show.nonce])

  const onOpen = (file: LibraryFile, tab: boolean) => {
    void invoke('downloads.preview', { id: file.id, tab }).then((ok) => {
      if (!ok) libraryToast(`${file.name} is no longer there`)
    })
  }
  const now = Date.now()
  return (
    <section className="archive dl-media" data-testid="media-section">
      <header className="archive__header">
        <div className="archive__heading">
          <h1 className="archive__title">Media</h1>
        </div>
      </header>
      <div
        ref={scrollerRef}
        className="dl-media__scroller"
        data-testid="media-list"
        data-answered={files ? 'true' : 'false'}
      >
        {days.map(({ day, files: group }) => (
          <section key={day} className="dl-media__day" aria-label={dayLabel(day, now)}>
            <h2 className="dl-media__day-title">{dayLabel(day, now)}</h2>
            <div className="dl-media__grid">
              {group.map((file) => (
                <Tile key={file.id} file={file} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ))}
        {files && files.length === 0 && (
          <div className="archive__empty" data-testid="media-empty">
            <p className="archive__empty-title">No images or videos yet</p>
            <p>Images and videos you download show up here.</p>
            {!screenshots && <p>To see your screenshots here too, right-click the Library button.</p>}
          </div>
        )}
      </div>
    </section>
  )
}
