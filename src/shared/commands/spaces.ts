import type { ProfileId, SpaceId, SpaceTheme } from '../state'

/** Owned by the spaces/profiles lane. */
export interface SpaceCommands {
  'spaces.create': {
    args: { name?: string; icon?: string; theme?: SpaceTheme; profileId?: ProfileId; activate?: boolean }
    result: SpaceId
  }
  'spaces.switch': { args: { spaceId: SpaceId }; result: void }
  'spaces.update': {
    args: { spaceId: SpaceId; name?: string; icon?: string; theme?: SpaceTheme; profileId?: ProfileId }
    result: void
  }
  'spaces.delete': { args: { spaceId: SpaceId }; result: void }
  'spaces.reorder': { args: { spaceId: SpaceId; index: number }; result: void }
  'profiles.create': { args: { name: string }; result: ProfileId }
  'profiles.rename': { args: { profileId: ProfileId; name: string }; result: void }
  'profiles.delete': { args: { profileId: ProfileId }; result: void }
}
