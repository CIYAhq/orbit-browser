import { ArrowRight, ClipboardList, FileUp, HelpCircle } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type BookmarkNode,
  type ImportDataType,
  type ImportJob,
  type ImportPlan,
  type ImportSession,
  type ImportSource,
  type ImportStart,
  type ImportTarget,
  type Inspection,
  MAX_FILE_BYTES,
  type ParsedFile,
  parseLinkList,
  TOO_LARGE,
} from '../../../shared/commands/import'
import { invoke } from '../api'
import { useOrbit } from '../store'
import { BookmarkTree } from './BookmarkTree'
import { MOVING_HEADING, MOVING_INTRO, MOVING_ROUTES, PASTE_DEFAULT_NAME } from './copy'
import { Progress } from './Progress'
import { SourcePicker, TypesPicker } from './sources'
import { filterTree, leafKeys, type TreeRoot } from './tree'
import './import.css'

type Route = 'browser' | 'file' | 'links'
type StepId = 'source' | 'profiles' | 'types' | 'bookmarks' | 'links' | 'target' | 'progress'

const STEP_TITLES: Record<StepId, string> = {
  source: 'Bring your bookmarks along',
  profiles: 'Choose profiles',
  types: 'What to import',
  bookmarks: 'Choose bookmarks',
  links: 'Paste a list of links',
  target: 'Where should it go?',
  progress: 'Importing',
}

/** A bookmarks file, read (IM-13): its tree, and its bookmarks left out past the limit of one import. */
interface FileTree {
  name: string
  tree: BookmarkNode[]
  cut: number
}

const UNREADABLE = 'Orbit couldn’t read this file'

interface Target {
  spaceId: string
  profileId: string
  newName: string
  matching: boolean
}

/**
 * The import flow (IM-01…IM-06, IM-12, IM-13): Back, Next and Cancel through the steps a route
 * needs. Nothing is imported before the last step's Import, and Cancel imports nothing. The import
 * window shows it, and so does onboarding's import step (`embedded`, OB-03), where the import is
 * held until onboarding ends.
 */
export function ImportFlow({
  session,
  embedded,
  onClose,
  onStarted,
}: {
  session: ImportSession | undefined
  embedded?: boolean
  /** Cancel (the window closes; onboarding moves on: "Do this later"). */
  onClose: () => void
  /** Embedded: the import was started (held). */
  onStarted?: (jobId: string) => void
}) {
  const [step, setStep] = useState<StepId>('source')
  const [route, setRoute] = useState<Route>()
  const [sources, setSources] = useState<ImportSource[]>()
  const [sourceId, setSourceId] = useState<string>()
  const [profileIds, setProfileIds] = useState<string[]>([])
  const [inspection, setInspection] = useState<Inspection | 'loading'>()
  const [types, setTypes] = useState<ImportDataType[]>([])
  const [file, setFile] = useState<FileTree>()
  const [fileError, setFileError] = useState<string>()
  const [linksText, setLinksText] = useState('')
  /** The .txt file the links came from (IM-13), if they weren't pasted. */
  const [linksFile, setLinksFile] = useState<string>()
  const [folderName, setFolderName] = useState(PASTE_DEFAULT_NAME)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<Target>()
  const [job, setJob] = useState<ImportJob | null>(null)
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const source = sources?.find((s) => s.id === sourceId)
  const roots: TreeRoot[] = useMemo(() => {
    if (route === 'file') return file ? [{ key: '', nodes: file.tree }] : []
    if (route !== 'browser' || !inspection || inspection === 'loading') return []
    const withMarks = inspection.profiles.filter((p) => p.bookmarks)
    return withMarks.map((p) => ({
      key: p.profileId,
      ...(withMarks.length > 1 ? { title: p.name } : {}),
      nodes: p.bookmarks?.tree ?? [],
    }))
  }, [route, file, inspection])
  const allKeys = useMemo(() => roots.flatMap((r) => leafKeys(r.key, r.nodes)), [roots])
  // Each new tree is drawn afresh: which folders are open isn't carried over from another file's.
  const treeSeq = useRef({ roots, n: 0 })
  if (treeSeq.current.roots !== roots) treeSeq.current = { roots, n: treeSeq.current.n + 1 }

  const steps = useMemo((): StepId[] => {
    if (route === 'file') return ['source', 'bookmarks', 'target', 'progress']
    if (route === 'links') return ['source', 'links', 'target', 'progress']
    const list: StepId[] = ['source']
    if (source && source.profiles.length > 1) list.push('profiles')
    list.push('types')
    if (types.includes('bookmarks')) list.push('bookmarks')
    list.push('target', 'progress')
    return list
  }, [route, source, types])

  const go = useCallback((to: StepId) => {
    setStep(to)
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }))
  }, [])

  // A new tree (a file, a profile's bookmarks) starts with everything chosen (IM-04).
  useEffect(() => setSelected(new Set(allKeys)), [allKeys])

  // Browsers on this computer (IM-02).
  useEffect(() => {
    void invoke('import.sources', {}).then(setSources)
  }, [])

  /** A dropped or chosen file (IM-13): its bookmarks to choose from, its links, or why it can't be read. */
  const openFile = (parsed: ParsedFile) => {
    setFileError(undefined)
    if (parsed.kind === 'error') {
      setFileError(`${parsed.name}: ${parsed.message}`)
      setRoute(undefined)
      setStep('source')
      return
    }
    if (parsed.kind === 'links') {
      setRoute('links')
      setLinksText(parsed.text)
      setLinksFile(parsed.name)
      go('links')
      return
    }
    setRoute('file')
    // The tree comes as JSON text, which main passed on without reading (D58).
    setFile({ name: parsed.name, tree: JSON.parse(parsed.json) as BookmarkNode[], cut: parsed.cut })
    go('bookmarks')
  }

  // Where the window was asked to start (a dropped file, a paste in the sidebar), else a running import.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening (the flow is keyed by it)
  useEffect(() => {
    const start: ImportStart | undefined = session?.start
    if (start?.kind === 'links') {
      setRoute('links')
      setLinksText(start.text)
      go('links')
    } else if (start?.kind === 'file') {
      openFile(start.file)
    } else if (!embedded && (session?.job?.phase === 'reading' || session?.job?.phase === 'adding')) {
      setJob(session.job)
      setStep('progress')
    }
  }, [])

  useEffect(
    () =>
      window.orbit.on('import.progress', (status) => {
        setJob((current) => (current && current.id === (status as ImportJob).id ? (status as ImportJob) : current))
      }),
    [],
  )

  /** Reads a file, saying so when that fails (F1). */
  const readFile = async (name: string, read: () => Promise<ParsedFile | null>) => {
    let parsed: ParsedFile | null
    try {
      parsed = await read()
    } catch {
      parsed = { kind: 'error', name, message: UNREADABLE }
    }
    if (parsed) openFile(parsed)
  }

  const chooseFile = () => readFile('file', () => invoke('import.chooseFile', {}))

  // Inspect the chosen profiles when they change (IM-03).
  const inspect = useCallback(async (id: string, profiles: string[]) => {
    setInspection('loading')
    const result = await invoke('import.inspect', { sourceId: id, profileIds: profiles })
    setInspection(result)
    const offered = new Set<ImportDataType>()
    for (const p of result.profiles) {
      if (p.bookmarks) offered.add('bookmarks')
      if (p.history) offered.add('history')
    }
    // Everything the source offers starts checked, except cookies (P2, off by default, IM-10).
    setTypes([...offered])
  }, [])

  const pickSource = (id: string) => {
    const s = sources?.find((x) => x.id === id)
    if (!s || s.blocked) return
    setRoute('browser')
    setSourceId(id)
    const firstProfile = s.profiles[0]?.id
    setProfileIds(firstProfile ? [firstProfile] : [])
    setInspection(undefined)
  }

  const index = steps.indexOf(step)
  const linkCount = useMemo(() => parseLinkList(linksText).links.length, [linksText])

  const canNext = (() => {
    switch (step) {
      case 'source':
        return route === 'browser' && !!source && !source.blocked
      case 'profiles':
        return profileIds.length > 0
      case 'types':
        return types.length > 0 && inspection !== 'loading' && !!inspection
      case 'bookmarks':
        return selected.size > 0 || (route === 'browser' && types.length > 1)
      case 'links':
        return linkCount > 0 && folderName.trim().length > 0
      case 'target':
        return !!target && (target.spaceId !== 'new' || target.newName.trim().length > 0) && !busy
      default:
        return false
    }
  })()

  const next = async () => {
    if (!canNext) return
    const to = steps[index + 1]
    if (step === 'source' && route === 'browser' && sourceId && source && source.profiles.length <= 1) {
      void inspect(sourceId, profileIds)
    }
    if (step === 'profiles' && sourceId) void inspect(sourceId, profileIds)
    if (step === 'target') {
      await start()
      return
    }
    if (to) go(to)
  }

  const back = () => {
    const to = steps[index - 1]
    if (!to) return
    if (to === 'source') {
      setRoute(undefined)
      setFile(undefined)
    }
    go(to)
  }

  const plan = (): ImportPlan | undefined => {
    if (!target) return undefined
    const t: ImportTarget = target.matching
      ? { kind: 'matching' }
      : target.spaceId === 'new'
        ? { kind: 'new-space', name: target.newName.trim(), profileId: target.profileId }
        : { kind: 'space', spaceId: target.spaceId }
    const hold = embedded ? { hold: true } : {}
    if (route === 'file' && file) {
      const bookmarks = filterTree(file.tree, '', selected)
      return {
        kind: 'file',
        name: file.name,
        bookmarks,
        ...(file.cut > 0 ? { cut: file.cut } : {}),
        target: t,
        ...hold,
      }
    }
    if (route === 'links') {
      const name = linksFile ? { name: linksFile } : {}
      return { kind: 'links', folderName: folderName.trim(), text: linksText, ...name, target: t, ...hold }
    }
    if (route === 'browser' && sourceId && inspection && inspection !== 'loading') {
      return {
        kind: 'browser',
        sourceId,
        profiles: inspection.profiles.map((p) => ({
          profileId: p.profileId,
          types: types.filter((ty) => (ty !== 'bookmarks' || !!p.bookmarks) && (ty !== 'history' || !!p.history)),
          ...(types.includes('bookmarks') && p.bookmarks
            ? { bookmarks: filterTree(p.bookmarks.tree, p.profileId, selected) }
            : {}),
        })),
        target: t,
        ...hold,
      }
    }
    return undefined
  }

  const start = async () => {
    const p = plan()
    if (!p || busy) return
    setBusy(true)
    try {
      const jobId = await invoke('import.start', { plan: p })
      if (embedded) {
        onStarted?.(jobId)
        return
      }
      setJob(await invoke('import.status', { jobId }))
      go('progress')
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    if (job && (job.phase === 'reading' || job.phase === 'held')) void invoke('import.cancel', { jobId: job.id })
    onClose()
  }

  // Dropping a bookmarks file or a list of links on the flow starts that route (IM-13).
  const onDrop = async (e: React.DragEvent) => {
    const f = e.dataTransfer.files[0]
    if (!f || step === 'progress') return
    e.preventDefault()
    // A file over the limit isn't read at all (F2).
    if (f.size > MAX_FILE_BYTES) {
      openFile({ kind: 'error', name: f.name, message: TOO_LARGE })
      return
    }
    await readFile(f.name, async () => invoke('import.parseFile', { name: f.name, text: await f.text() }))
  }

  // Enter is Next and Escape is Back (the window: Escape on the first step cancels). In onboarding the
  // first step leaves both keys to onboarding, so Enter moves on ("Do this later") as on every step.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const el = e.target instanceof Element ? e.target : null
    // Enter in a text field (the folder's name) is Next too; not on a button, a checkbox or in the list of links.
    if (e.key === 'Enter' && !el?.closest('button, a, select, textarea, [role="radio"], input[type="checkbox"]')) {
      if (step === 'source' && !canNext) return
      e.preventDefault()
      if (step !== 'progress') void next()
    } else if (e.key === 'Escape' && !(el instanceof HTMLSelectElement)) {
      if (index > 0 && step !== 'progress') {
        e.preventDefault()
        back()
      } else if (!embedded) {
        e.preventDefault()
        if (step === 'progress') onClose()
        else cancel()
      }
    }
  }

  const nextLabel = step === 'target' ? 'Import' : 'Next'
  const title = step === 'source' && embedded ? 'Bring your bookmarks along' : STEP_TITLES[step]
  const running = job && (job.phase === 'reading' || job.phase === 'adding')

  return (
    <div
      className={`im-flow${embedded ? ' im-flow--embedded' : ''}`}
      data-testid="import-flow"
      data-step={step}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') && step !== 'progress') {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="im-flow__body" ref={bodyRef} data-testid={`import-step-${step}`}>
        <h1 className="im-title" tabIndex={-1} id={embedded ? 'ob-title-import' : undefined}>
          {title}
        </h1>
        {step === 'source' && (
          <>
            <p className="im-lead">
              Copy bookmarks and history from another browser on this computer, or bring them from a file.
            </p>
            <SourcePicker sources={sources} chosen={sourceId} onPick={pickSource} onOpen={() => void next()} />
            <div className="im-other" role="group" aria-label="Other ways">
              <OtherWay
                icon={<FileUp size={16} />}
                title="From a file…"
                text="A bookmarks file (.html) or a list of links (.txt). You can also drop it here."
                testId="import-from-file"
                onClick={() => void chooseFile()}
              />
              <OtherWay
                icon={<ClipboardList size={16} />}
                title="Paste a list of links"
                text="One address per line, or “Title — address”."
                testId="import-paste"
                onClick={() => {
                  setRoute('links')
                  setLinksFile(undefined)
                  go('links')
                }}
              />
            </div>
            {fileError && (
              <p className="im-error" role="alert" data-testid="import-file-error">
                {fileError}
              </p>
            )}
            <MovingHelp />
          </>
        )}
        {step === 'profiles' && source && <ProfilesStep source={source} chosen={profileIds} onChange={setProfileIds} />}
        {step === 'types' && (
          <TypesPicker
            inspection={inspection}
            types={types}
            onChange={setTypes}
            onRetry={() => sourceId && void inspect(sourceId, profileIds)}
          />
        )}
        {step === 'bookmarks' && (
          <>
            <div className="im-tree-bar">
              <span data-testid="import-count" aria-live="polite">
                {selected.size.toLocaleString()} of {allKeys.length.toLocaleString()} bookmarks selected
              </span>
              <button
                type="button"
                className="im-link"
                data-testid="import-select-all"
                onClick={() => setSelected(new Set(allKeys))}
              >
                Select all
              </button>
              <button
                type="button"
                className="im-link"
                data-testid="import-select-none"
                onClick={() => setSelected(new Set())}
              >
                Select none
              </button>
            </div>
            <BookmarkTree key={treeSeq.current.n} roots={roots} selected={selected} onChange={setSelected} />
          </>
        )}
        {step === 'links' && (
          <LinksStep
            text={linksText}
            onText={setLinksText}
            name={folderName}
            onName={setFolderName}
            count={linkCount}
          />
        )}
        {step === 'target' && (
          <TargetStep
            embedded={!!embedded}
            sessionSpace={session?.spaceId}
            sourceProfiles={route === 'browser' ? profileIds.length : 1}
            value={target}
            onChange={setTarget}
          />
        )}
        {step === 'progress' && job && <Progress job={job} />}
      </div>
      <footer className="im-flow__footer">
        {step === 'progress' ? (
          <>
            {running && job?.phase === 'reading' ? (
              <Button onClick={cancel} testId="import-cancel">
                Cancel
              </Button>
            ) : (
              <span />
            )}
            {job?.phase === 'done' ? (
              <Button primary testId="import-done" onClick={() => void invoke('import.reveal', { jobId: job.id })}>
                Done
              </Button>
            ) : (
              <Button onClick={onClose} testId="import-hide">
                {running ? 'Hide' : 'Close'}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={cancel} testId={embedded ? 'onboarding-import-later' : 'import-cancel'}>
              {embedded ? 'Do this later' : 'Cancel'}
            </Button>
            <div className="im-flow__nav">
              {index > 0 && (
                <Button onClick={back} testId="import-back">
                  Back
                </Button>
              )}
              {/* In onboarding, "Do this later" weighs the same as Next (OB-03). */}
              <Button primary={!embedded} disabled={!canNext} onClick={() => void next()} testId="import-next">
                {nextLabel}
                {step !== 'target' && <ArrowRight size={14} aria-hidden="true" />}
              </Button>
            </div>
          </>
        )}
      </footer>
    </div>
  )
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  testId,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      className={`im-button${primary ? ' im-button--primary' : ''}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

function OtherWay({
  icon,
  title,
  text,
  testId,
  onClick,
}: {
  icon: ReactNode
  title: string
  text: string
  testId: string
  onClick: () => void
}) {
  return (
    <button type="button" className="im-way" data-testid={testId} onClick={onClick}>
      <span className="im-way__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="im-way__text">
        <strong>{title}</strong>
        <span>{text}</span>
      </span>
    </button>
  )
}

/** "Coming from …?": the routes in plain words (IM-12). Nothing is read from that browser. */
function MovingHelp() {
  return (
    <details className="im-help" data-testid="import-moving-help">
      <summary>
        <HelpCircle size={14} aria-hidden="true" />
        {MOVING_HEADING}
      </summary>
      <p>{MOVING_INTRO}</p>
      <ul>
        {MOVING_ROUTES.map((r) => (
          <li key={r.title}>
            <strong>{r.title}.</strong> {r.text}
          </li>
        ))}
      </ul>
    </details>
  )
}

function ProfilesStep({
  source,
  chosen,
  onChange,
}: {
  source: ImportSource
  chosen: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <>
      <p className="im-lead">{source.name} has several profiles. Choose one or more.</p>
      <div className="im-checks" data-testid="import-profiles">
        {source.profiles.map((p) => (
          <label key={p.id} className="im-check">
            <input
              type="checkbox"
              checked={chosen.includes(p.id)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, p.id] : chosen.filter((id) => id !== p.id))}
            />
            <span className="im-avatar" aria-hidden="true">
              {p.name.charAt(0).toUpperCase()}
            </span>
            <span>{p.name}</span>
          </label>
        ))}
      </div>
    </>
  )
}

function LinksStep({
  text,
  onText,
  name,
  onName,
  count,
}: {
  text: string
  onText: (t: string) => void
  name: string
  onName: (n: string) => void
  count: number
}) {
  return (
    <>
      <p className="im-lead">
        Paste links copied from another browser: one address per line, or “Title — address”. Each becomes a pinned tab,
        in this order, in one new folder.
      </p>
      <textarea
        className="im-textarea"
        data-testid="import-links-text"
        aria-label="Links"
        placeholder={'https://example.com\nNews — https://news.example.com'}
        value={text}
        spellCheck={false}
        onChange={(e) => onText(e.target.value)}
      />
      <label className="im-field">
        <span>Folder name</span>
        <input
          className="im-input"
          data-testid="import-folder-name"
          value={name}
          maxLength={200}
          onChange={(e) => onName(e.target.value)}
        />
      </label>
      <p className="im-note" data-testid="import-links-count" aria-live="polite">
        {count === 0 ? 'No links yet' : count === 1 ? '1 link' : `${count.toLocaleString()} links`}
      </p>
    </>
  )
}

/** Profile and Space (IM-06): the current Space by default, the first one in onboarding; or a new Space. */
function TargetStep({
  embedded,
  sessionSpace,
  sourceProfiles,
  value,
  onChange,
}: {
  embedded: boolean
  sessionSpace: string | undefined
  sourceProfiles: number
  value: Target | undefined
  onChange: (t: Target) => void
}) {
  const spaces = useOrbit((s) => s.spaces)
  const order = useOrbit((s) => s.spaceOrder)
  const profiles = useOrbit((s) => s.profiles)
  const persistent = useMemo(
    () => Object.values(profiles).filter((p) => p.partition.startsWith('persist:')),
    [profiles],
  )
  useEffect(() => {
    if (value) return
    const first = embedded ? order[0] : (sessionSpace ?? order[0])
    const space = first ? spaces[first] : undefined
    onChange({
      spaceId: space?.id ?? 'new',
      profileId: space?.profileId ?? persistent[0]?.id ?? '',
      newName: 'Imported',
      matching: false,
    })
  }, [value, embedded, sessionSpace, order, spaces, persistent, onChange])
  if (!value) return null
  const inProfile = order.filter((id) => spaces[id]?.profileId === value.profileId)
  return (
    <div className="im-target" data-testid="import-target">
      <p className="im-lead">Bookmarks become a pinned folder in the Space. History goes to its profile.</p>
      {sourceProfiles > 1 && (
        <label className="im-check">
          <input
            type="checkbox"
            data-testid="import-matching"
            checked={value.matching}
            onChange={(e) => onChange({ ...value, matching: e.target.checked })}
          />
          <span>Make a matching Orbit profile and Space for each profile</span>
        </label>
      )}
      {!value.matching && (
        <>
          <label className="im-field">
            <span>Profile</span>
            <select
              className="im-input"
              data-testid="import-target-profile"
              value={value.profileId}
              onChange={(e) => {
                const profileId = e.target.value
                const firstSpace = order.find((id) => spaces[id]?.profileId === profileId)
                onChange({ ...value, profileId, spaceId: firstSpace ?? 'new' })
              }}
            >
              {persistent.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="im-field">
            <span>Space</span>
            <select
              className="im-input"
              data-testid="import-target-space"
              value={value.spaceId}
              onChange={(e) => onChange({ ...value, spaceId: e.target.value })}
            >
              {inProfile.map((id) => (
                <option key={id} value={id}>
                  {spaces[id]?.name}
                </option>
              ))}
              <option value="new">New Space…</option>
            </select>
          </label>
          {value.spaceId === 'new' && (
            <label className="im-field">
              <span>New Space’s name</span>
              <input
                className="im-input"
                data-testid="import-new-space"
                value={value.newName}
                maxLength={60}
                onChange={(e) => onChange({ ...value, newName: e.target.value })}
              />
            </label>
          )}
        </>
      )}
    </div>
  )
}
