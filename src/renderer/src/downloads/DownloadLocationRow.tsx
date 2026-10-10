import { useEffect, useState } from 'react'
import type { ProfileId } from '../../../shared/state'
import { invoke } from '../api'
import { type Option, Select, SettingRow } from '../settings/controls'
import { useOrbit } from '../store'

type Choice = 'folder' | 'other' | 'ask'

/**
 * Settings → Profiles → [profile] → Download location (DL-07): the profile's folder, Other… (the OS
 * folder picker) or Ask every time.
 */
export function DownloadLocationRow({ profileId, name }: { profileId: ProfileId; name: string }) {
  const ask = useOrbit((s) => s.profiles[profileId]?.downloadAsk === true)
  const chosen = useOrbit((s) => s.profiles[profileId]?.downloadFolder)
  const [folder, setFolder] = useState(chosen)
  useEffect(() => {
    if (chosen) {
      setFolder(chosen)
      return
    }
    // The OS Downloads folder: only main knows where it is.
    let current = true
    void invoke('downloads.location', { profileId }).then((l) => {
      if (current) setFolder(l.folder)
    })
    return () => {
      current = false
    }
  }, [profileId, chosen])
  const options: Option<Choice>[] = [
    { value: 'folder', label: folder ? folderName(folder) : 'Downloads' },
    { value: 'other', label: 'Other…' },
    { value: 'ask', label: 'Ask every time' },
  ]
  return (
    <SettingRow
      id="download-location"
      label="Download location"
      description={
        ask
          ? 'Orbit asks where to save each download, starting in the folder you saved to last.'
          : folder && <span data-testid={`download-folder-${profileId}`}>{folder}</span>
      }
      profile={name}
    >
      <Select
        label="Download location"
        value={ask ? 'ask' : 'folder'}
        options={options}
        testId={`download-location-${profileId}`}
        onChange={(choice) => {
          if (choice === 'other') void invoke('downloads.chooseFolder', { profileId })
          else void invoke('downloads.setAsk', { profileId, ask: choice === 'ask' })
        }}
      />
    </SettingRow>
  )
}

/** A folder by its last part, as file managers name it ("Downloads"). */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
