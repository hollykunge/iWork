import { MenuIDs } from '../main-process/menu'
import { merge } from './merge'
import { IAppState, SelectionType } from '../lib/app-state'
import { Repository } from '../models/repository'
import { CloningRepository } from '../models/cloning-repository'
import { TipState } from '../models/tip'
import { updateMenuState as ipcUpdateMenuState } from '../ui/main-process-proxy'
import { AppMenu, MenuItem } from '../models/app-menu'

export interface IMenuItemState {
  readonly enabled?: boolean
}

/**
 * Utility class for coalescing updates to menu items
 */
class MenuStateBuilder {
  private readonly _state: Map<MenuIDs, IMenuItemState>

  public constructor(state: Map<MenuIDs, IMenuItemState> = new Map()) {
    this._state = state
  }

  /**
   * Returns an Map where each key is a MenuID and the values
   * are IMenuItemState instances containing information about
   * whether a particular menu item should be enabled/disabled or
   * visible/hidden.
   */
  public get state() {
    return new Map<MenuIDs, IMenuItemState>(this._state)
  }

  private updateMenuItem<K extends keyof IMenuItemState>(
    id: MenuIDs,
    state: Pick<IMenuItemState, K>
  ) {
    const currentState = this._state.get(id) || {}
    this._state.set(id, merge(currentState, state))
  }

  /** Set the state of the given menu item id to enabled */
  public enable(id: MenuIDs): this {
    this.updateMenuItem(id, { enabled: true })
    return this
  }

  /** Set the state of the given menu item id to disabled */
  public disable(id: MenuIDs): this {
    this.updateMenuItem(id, { enabled: false })
    return this
  }

  /** Set the enabledness of the given menu item id */
  public setEnabled(id: MenuIDs, enabled: boolean): this {
    this.updateMenuItem(id, { enabled })
    return this
  }

  /**
   * Create a new state builder by merging the current state with the state from
   * the other state builder. This will replace values in `this` with values
   * from `other`.
   */
  public merge(other: MenuStateBuilder): MenuStateBuilder {
    const merged = new Map<MenuIDs, IMenuItemState>(this._state)
    for (const [key, value] of other._state) {
      merged.set(key, value)
    }
    return new MenuStateBuilder(merged)
  }
}

function isRepositoryHostedOnGitHub(
  repository: Repository | CloningRepository
) {
  if (
    !repository ||
    repository instanceof CloningRepository ||
    !repository.gitHubRepository
  ) {
    return false
  }

  return repository.gitHubRepository.htmlURL !== null
}

function menuItemStateEqual(state: IMenuItemState, menuItem: MenuItem) {
  if (
    state.enabled !== undefined &&
    menuItem.type !== 'separator' &&
    menuItem.enabled !== state.enabled
  ) {
    return false
  }

  return true
}

const allMenuIds: ReadonlyArray<MenuIDs> = [
  'rename-branch',
  'delete-branch',
  'preferences',
  'update-branch',
  'merge-branch',
  'view-repository-on-github',
  'compare-on-github',
  'open-in-shell',
  'push',
  'pull',
  'branch',
  'repository',
  'create-branch',
  'show-changes',
  'show-history',
  'show-repository-list',
  'show-branches-list',
  'open-working-directory',
  'show-repository-settings',
  'open-external-editor',
  'remove-repository',
  'new-repository',
  'add-local-repository',
  'clone-repository',
  'about',
  'create-pull-request',
]

function getAllMenusDisabledBuilder(): MenuStateBuilder {
  const menuStateBuilder = new MenuStateBuilder()

  for (const menuId of allMenuIds) {
    menuStateBuilder.disable(menuId)
  }

  return menuStateBuilder
}

function getRepositoryMenuBuilder(state: IAppState): MenuStateBuilder {
  const selectedState = state.selectedState
  const isHostedOnGitHub = selectedState
    ? isRepositoryHostedOnGitHub(selectedState.repository)
    : false

  let repositorySelected = false
  let onNonDefaultBranch = false
  let onBranch = false
  let hasDefaultBranch = false
  let hasPublishedBranch = false
  let networkActionInProgress = false
  let tipStateIsUnknown = false
  let branchIsUnborn = false

  let hasRemote = false

  if (selectedState && selectedState.type === SelectionType.Repository) {
    repositorySelected = true

    const branchesState = selectedState.state.branchesState
    const tip = branchesState.tip
    const defaultBranch = branchesState.defaultBranch

    hasDefaultBranch = Boolean(defaultBranch)

    onBranch = tip.kind === TipState.Valid
    tipStateIsUnknown = tip.kind === TipState.Unknown
    branchIsUnborn = tip.kind === TipState.Unborn

    // If we are:
    //  1. on the default branch, or
    //  2. on an unborn branch, or
    //  3. on a detached HEAD
    // there's not much we can do.
    if (tip.kind === TipState.Valid) {
      if (defaultBranch !== null) {
        onNonDefaultBranch = tip.branch.name !== defaultBranch.name
      }

      hasPublishedBranch = !!tip.branch.upstream
    } else {
      onNonDefaultBranch = true
    }

    hasRemote = !!selectedState.state.remote

    networkActionInProgress = selectedState.state.isPushPullFetchInProgress
  }

  // These are IDs for menu items that are entirely _and only_
  // repository-scoped. They're always enabled if we're in a repository and
  // always disabled if we're not.
  const repositoryScopedIDs: ReadonlyArray<MenuIDs> = [
    'branch',
    'repository',
    'remove-repository',
    'open-in-shell',
    'open-working-directory',
    'show-repository-settings',
    'show-changes',
    'show-history',
    'show-branches-list',
    'open-external-editor',
    'compare-to-branch',
  ]

  const menuStateBuilder = new MenuStateBuilder()

  const windowOpen = state.windowState !== 'hidden'
  const inWelcomeFlow = state.showWelcomeFlow
  const repositoryActive = windowOpen && repositorySelected && !inWelcomeFlow

  if (repositoryActive) {
    for (const id of repositoryScopedIDs) {
      menuStateBuilder.enable(id)
    }

    menuStateBuilder.setEnabled(
      'rename-branch',
      onNonDefaultBranch && !branchIsUnborn
    )
    menuStateBuilder.setEnabled(
      'delete-branch',
      onNonDefaultBranch && !branchIsUnborn
    )
    menuStateBuilder.setEnabled(
      'update-branch',
      onNonDefaultBranch && hasDefaultBranch
    )
    menuStateBuilder.setEnabled('merge-branch', onBranch)
    menuStateBuilder.setEnabled(
      'compare-on-github',
      isHostedOnGitHub && hasPublishedBranch
    )

    menuStateBuilder.setEnabled('view-repository-on-github', isHostedOnGitHub)
    menuStateBuilder.setEnabled(
      'create-pull-request',
      isHostedOnGitHub && !branchIsUnborn
    )
    menuStateBuilder.setEnabled(
      'push',
      hasRemote && !branchIsUnborn && !networkActionInProgress
    )
    menuStateBuilder.setEnabled(
      'pull',
      hasPublishedBranch && !networkActionInProgress
    )
    menuStateBuilder.setEnabled(
      'create-branch',
      !tipStateIsUnknown && !branchIsUnborn
    )

    if (
      selectedState &&
      selectedState.type === SelectionType.MissingRepository
    ) {
      menuStateBuilder.disable('open-external-editor')
    }
  } else {
    for (const id of repositoryScopedIDs) {
      menuStateBuilder.disable(id)
    }

    menuStateBuilder.disable('view-repository-on-github')
    menuStateBuilder.disable('create-pull-request')

    if (
      selectedState &&
      selectedState.type === SelectionType.MissingRepository
    ) {
      if (selectedState.repository.gitHubRepository) {
        menuStateBuilder.enable('view-repository-on-github')
      }
      menuStateBuilder.enable('remove-repository')
    }

    menuStateBuilder.disable('create-branch')
    menuStateBuilder.disable('rename-branch')
    menuStateBuilder.disable('delete-branch')
    menuStateBuilder.disable('update-branch')
    menuStateBuilder.disable('merge-branch')

    menuStateBuilder.disable('push')
    menuStateBuilder.disable('pull')
    menuStateBuilder.disable('compare-to-branch')
  }
  return menuStateBuilder
}

function getMenuState(state: IAppState): Map<MenuIDs, IMenuItemState> {
  if (state.currentPopup) {
    return getAllMenusDisabledBuilder().state
  }

  return getAllMenusEnabledBuilder()
    .merge(getRepositoryMenuBuilder(state))
    .merge(getInWelcomeFlowBuilder(state.showWelcomeFlow)).state
}

function getAllMenusEnabledBuilder(): MenuStateBuilder {
  const menuStateBuilder = new MenuStateBuilder()
  for (const menuId of allMenuIds) {
    menuStateBuilder.enable(menuId)
  }
  return menuStateBuilder
}

function getInWelcomeFlowBuilder(inWelcomeFlow: boolean): MenuStateBuilder {
  const welcomeScopedIds: ReadonlyArray<MenuIDs> = [
    'new-repository',
    'add-local-repository',
    'clone-repository',
    'preferences',
    'about',
  ]

  const menuStateBuilder = new MenuStateBuilder()
  if (inWelcomeFlow) {
    for (const id of welcomeScopedIds) {
      menuStateBuilder.disable(id)
    }
  } else {
    for (const id of welcomeScopedIds) {
      menuStateBuilder.enable(id)
    }
  }

  return menuStateBuilder
}

/**
 * Update the menu state in the main process.
 *
 * This function will set the enabledness and visibility of menu items
 * in the main process based on the AppState. All changes will be
 * batched together into one ipc message.
 */
export function updateMenuState(
  state: IAppState,
  currentAppMenu: AppMenu | null
) {
  const menuState = getMenuState(state)

  // Try to avoid updating sending the IPC message at all
  // if we have a current app menu that we can compare against.
  if (currentAppMenu) {
    for (const [id, menuItemState] of menuState.entries()) {
      const appMenuItem = currentAppMenu.getItemById(id)

      if (appMenuItem && menuItemStateEqual(menuItemState, appMenuItem)) {
        menuState.delete(id)
      }
    }
  }

  if (menuState.size === 0) {
    return
  }

  // because we can't send Map over the wire, we need to convert
  // the remaining entries into an array that can be serialized
  const array = new Array<{ id: MenuIDs; state: IMenuItemState }>()
  menuState.forEach((value, key) => array.push({ id: key, state: value }))
  ipcUpdateMenuState(array)
}
