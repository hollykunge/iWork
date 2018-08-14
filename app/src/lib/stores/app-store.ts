import { ipcRenderer, remote } from 'electron'
import {
  IRepositoryState,
  IHistoryState,
  IAppState,
  RepositorySectionTab,
  IChangesState,
  Popup,
  PopupType,
  Foldout,
  FoldoutType,
  IBranchesState,
  PossibleSelections,
  SelectionType,
  ICheckoutProgress,
  Progress,
  ImageDiffType,
  IRevertProgress,
  IFetchProgress,
  ICompareState,
  ComparisonView,
  CompareAction,
  CompareActionKind,
  IDisplayHistory,
  ICompareBranch,
  ICompareFormUpdate,
} from '../app-state'
import { Account } from '../../models/account'
import { Repository } from '../../models/repository'
import { GitHubRepository } from '../../models/github-repository'
import {
  CommittedFileChange,
  WorkingDirectoryStatus,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { DiffSelection, DiffSelectionType, DiffType } from '../../models/diff'
import {
  matchGitHubRepository,
  IMatchedGitHubRepository,
  repositoryMatchesRemote,
} from '../repository-matching'
import { API, getAccountForEndpoint, IAPIUser } from '../api'
import { caseInsensitiveCompare } from '../compare'
import { Branch, eligibleForFastForward } from '../../models/branch'
import { TipState } from '../../models/tip'
import { CloningRepository } from '../../models/cloning-repository'
import { Commit } from '../../models/commit'
import { ExternalEditor, getAvailableEditors, parse } from '../editors'
import { IGitHubUser } from '../databases/github-user-database'
import { shell } from '../app-shell'
import { assertNever, forceUnwrap } from '../fatal-error'
import { BackgroundFetcher } from './helpers/background-fetcher'
import { formatCommitMessage } from '../format-commit-message'
import { AppMenu, IMenu } from '../../models/app-menu'
import {
  getAppMenu,
  updatePreferredAppMenuItemLabels,
} from '../../ui/main-process-proxy'
import { merge } from '../merge'
import { getAppPath } from '../../ui/lib/app-proxy'
import { StatsStore, ILaunchStats } from '../stats'
import { hasShownWelcomeFlow, markWelcomeFlowComplete } from '../welcome'
import { WindowState, getWindowState } from '../window-state'
import { fatalError } from '../fatal-error'
import { updateMenuState } from '../menu-update'

import {
  getAuthorIdentity,
  pull as pullRepo,
  push as pushRepo,
  createBranch,
  renameBranch,
  deleteBranch,
  getCommitDiff,
  getWorkingDirectoryDiff,
  getChangedFiles,
  updateRef,
  addRemote,
  getBranchAheadBehind,
  createCommit,
  checkoutBranch,
  getDefaultRemote,
  formatAsLocalRef,
  getMergeBase,
  getRemotes,
  ITrailer,
  isCoAuthoredByTrailer,
} from '../git'

import { launchExternalEditor } from '../editors'
import { TypedBaseStore } from './base-store'
import {
  AccountsStore,
  RepositoriesStore,
  RepositorySettingsStore,
  PullRequestStore,
  SignInStore,
  IssuesStore,
  GitStore,
  ICommitMessage,
  EmojiStore,
  GitHubUserStore,
  CloningRepositoriesStore,
} from '.'
import { validatedRepositoryPath } from './helpers/validated-repository-path'
import { IGitAccount } from '../git/authentication'
import { getGenericHostname, getGenericUsername } from '../generic-git-auth'
import { RetryActionType, RetryAction } from '../retry-actions'
import { findEditorOrDefault } from '../editors'
import {
  Shell,
  parse as parseShell,
  Default as DefaultShell,
  findShellOrDefault,
  launchShell,
} from '../shells'
import {
  installGlobalLFSFilters,
  isUsingLFS,
  installLFSHooks,
} from '../git/lfs'
import { CloneRepositoryTab } from '../../models/clone-repository-tab'
import { getAccountForRepository } from '../get-account-for-repository'
import { BranchesTab } from '../../models/branches-tab'
import { ItemsTab } from '../../models/items-tab'
import { Owner } from '../../models/owner'
import { PullRequest } from '../../models/pull-request'
import { PullRequestUpdater } from './helpers/pull-request-updater'
import * as QueryString from 'querystring'
import { IRemote, ForkedRemotePrefix } from '../../models/remote'
import { IAuthor } from '../../models/author'
import { ComparisonCache } from '../comparison-cache'
import { AheadBehindUpdater } from './helpers/ahead-behind-updater'
import { enableCompareSidebar } from '../feature-flag'

/**
 * Enum used by fetch to determine if
 * a fetch was initiated by the backgroundFetcher
 */
export enum FetchType {
  BackgroundTask,
  UserInitiatedTask,
}

/**
 * As fast-forwarding local branches is proportional to the number of local
 * branches, and is run after every fetch/push/pull, this is skipped when the
 * number of eligible branches is greater than a given threshold.
 */
const FastForwardBranchesThreshold = 20

const LastSelectedRepositoryIDKey = 'last-selected-repository-id'

const defaultSidebarWidth: number = 250
const sidebarWidthConfigKey: string = 'sidebar-width'

const defaultCommitSummaryWidth: number = 250
const commitSummaryWidthConfigKey: string = 'commit-summary-width'

const confirmRepoRemovalDefault: boolean = true
const confirmDiscardChangesDefault: boolean = true
const confirmRepoRemovalKey: string = 'confirmRepoRemoval'
const confirmDiscardChangesKey: string = 'confirmDiscardChanges'

const externalEditorKey: string = 'externalEditor'

const imageDiffTypeDefault = ImageDiffType.TwoUp
const imageDiffTypeKey = 'image-diff-type'

const shellKey = 'shell'

// background fetching should not occur more than once every two minutes
const BackgroundFetchMinimumInterval = 2 * 60 * 1000

export class AppStore extends TypedBaseStore<IAppState> {
  private accounts: ReadonlyArray<Account> = new Array<Account>()
  private repositories: ReadonlyArray<Repository> = new Array<Repository>()

  private selectedRepository: Repository | CloningRepository | null = null

  /** The background fetcher for the currently selected repository. */
  private currentBackgroundFetcher: BackgroundFetcher | null = null

  /** The pull request updater for the currently selected repository */
  private currentPullRequestUpdater: PullRequestUpdater | null = null

  /** The ahead/behind updater or the currently selected repository */
  private currentAheadBehindUpdater: AheadBehindUpdater | null = null

  private repositoryState = new Map<string, IRepositoryState>()
  private showWelcomeFlow = false
  private currentPopup: Popup | null = null
  private currentFoldout: Foldout | null = null
  private errors: ReadonlyArray<Error> = new Array<Error>()
  private emitQueued = false

  /** GitStores keyed by their hash. */
  private readonly gitStores = new Map<string, GitStore>()
  private readonly repositorySettingsStores = new Map<
    string,
    RepositorySettingsStore
  >()
  public readonly gitHubUserStore: GitHubUserStore
  private readonly cloningRepositoriesStore: CloningRepositoriesStore
  private readonly emojiStore: EmojiStore
  private readonly _issuesStore: IssuesStore
  private readonly signInStore: SignInStore
  private readonly accountsStore: AccountsStore
  private readonly repositoriesStore: RepositoriesStore
  private readonly statsStore: StatsStore
  private readonly pullRequestStore: PullRequestStore

  /** The issues store for all repositories. */
  public get issuesStore(): IssuesStore {
    return this._issuesStore
  }

  /**
   * The Application menu as an AppMenu instance or null if
   * the main process has not yet provided the renderer with
   * a copy of the application menu structure.
   */
  private appMenu: AppMenu | null = null

  /**
   * Used to highlight access keys throughout the app when the
   * Alt key is pressed. Only applicable on non-macOS platforms.
   */
  private highlightAccessKeys: boolean = false

  /**
   * A value indicating whether or not the current application
   * window has focus.
   */
  private appIsFocused: boolean = false

  private sidebarWidth: number = defaultSidebarWidth
  private commitSummaryWidth: number = defaultCommitSummaryWidth
  private windowState: WindowState
  private windowZoomFactor: number = 1
  private isUpdateAvailableBannerVisible: boolean = false
  private confirmRepoRemoval: boolean = confirmRepoRemovalDefault
  private confirmDiscardChanges: boolean = confirmDiscardChangesDefault
  private imageDiffType: ImageDiffType = imageDiffTypeDefault

  private selectedExternalEditor?: ExternalEditor

  /** The user's preferred shell. */
  private selectedShell = DefaultShell

  /** The current repository filter text */
  private repositoryFilterText: string = ''

  /** The function to resolve the current Open in Desktop flow. */
  private resolveOpenInDesktop:
    | ((repository: Repository | null) => void)
    | null = null

  private selectedCloneRepositoryTab = CloneRepositoryTab.DotCom

  private selectedBranchesTab = BranchesTab.Branches

  private selectedItemsTab = ItemsTab.Items

  public constructor(
    gitHubUserStore: GitHubUserStore,
    cloningRepositoriesStore: CloningRepositoriesStore,
    emojiStore: EmojiStore,
    issuesStore: IssuesStore,
    statsStore: StatsStore,
    signInStore: SignInStore,
    accountsStore: AccountsStore,
    repositoriesStore: RepositoriesStore,
    pullRequestStore: PullRequestStore
  ) {
    super()

    this.gitHubUserStore = gitHubUserStore
    this.cloningRepositoriesStore = cloningRepositoriesStore
    this.emojiStore = emojiStore
    this._issuesStore = issuesStore
    this.statsStore = statsStore
    this.signInStore = signInStore
    this.accountsStore = accountsStore
    this.repositoriesStore = repositoriesStore
    this.pullRequestStore = pullRequestStore
    this.showWelcomeFlow = !hasShownWelcomeFlow()

    const window = remote.getCurrentWindow()
    this.windowState = getWindowState(window)

    window.webContents.getZoomFactor(factor => {
      this.onWindowZoomFactorChanged(factor)
    })

    this.wireupIpcEventHandlers(window)
    this.wireupStoreEventHandlers()
    getAppMenu()
  }

  private wireupIpcEventHandlers(window: Electron.BrowserWindow) {
    ipcRenderer.on(
      'window-state-changed',
      (event: Electron.IpcMessageEvent, args: any[]) => {
        this.windowState = getWindowState(window)
        this.emitUpdate()
      }
    )

    ipcRenderer.on('zoom-factor-changed', (event: any, zoomFactor: number) => {
      this.onWindowZoomFactorChanged(zoomFactor)
    })

    ipcRenderer.on(
      'app-menu',
      (event: Electron.IpcMessageEvent, { menu }: { menu: IMenu }) => {
        this.setAppMenu(menu)
      }
    )
  }

  private wireupStoreEventHandlers() {
    this.gitHubUserStore.onDidUpdate(() => {
      this.emitUpdate()
    })

    this.cloningRepositoriesStore.onDidUpdate(() => {
      this.emitUpdate()
    })

    this.cloningRepositoriesStore.onDidError(e => this.emitError(e))

    this.signInStore.onDidAuthenticate(account => this._addAccount(account))
    this.signInStore.onDidUpdate(() => this.emitUpdate())
    this.signInStore.onDidError(error => this.emitError(error))

    this.accountsStore.onDidUpdate(async () => {
      const accounts = await this.accountsStore.getAll()
      this.accounts = accounts
      this.emitUpdate()
    })
    this.accountsStore.onDidError(error => this.emitError(error))

    this.repositoriesStore.onDidUpdate(async () => {
      const repositories = await this.repositoriesStore.getAll()
      this.repositories = repositories
      this.updateRepositorySelectionAfterRepositoriesChanged()
      this.emitUpdate()
    })

    this.pullRequestStore.onDidError(error => this.emitError(error))
    this.pullRequestStore.onDidUpdate(gitHubRepository =>
      this.onPullRequestStoreUpdated(gitHubRepository)
    )
  }

  /** Load the emoji from disk. */
  public loadEmoji() {
    const rootDir = getAppPath()
    this.emojiStore.read(rootDir).then(() => this.emitUpdate())
  }

  protected emitUpdate() {
    // If the window is hidden then we won't get an animation frame, but there
    // may still be work we wanna do in response to the state change. So
    // immediately emit the update.
    if (this.windowState === 'hidden') {
      this.emitUpdateNow()
      return
    }

    if (this.emitQueued) {
      return
    }

    this.emitQueued = true

    window.requestAnimationFrame(() => {
      this.emitUpdateNow()
    })
  }

  private emitUpdateNow() {
    this.emitQueued = false
    const state = this.getState()

    super.emitUpdate(state)
    updateMenuState(state, this.appMenu)
  }

  /**
   * Called when we have reason to suspect that the zoom factor
   * has changed. Note that this doesn't necessarily mean that it
   * has changed with regards to our internal state which is why
   * we double check before emitting an update.
   */
  private onWindowZoomFactorChanged(zoomFactor: number) {
    const current = this.windowZoomFactor
    this.windowZoomFactor = zoomFactor

    if (zoomFactor !== current) {
      this.emitUpdate()
    }
  }

  private getInitialRepositoryState(): IRepositoryState {
    return {
      historyState: {
        selection: {
          sha: null,
          file: null,
        },
        changedFiles: new Array<CommittedFileChange>(),
        history: new Array<string>(),
        diff: null,
      },
      changesState: {
        workingDirectory: WorkingDirectoryStatus.fromFiles(
          new Array<WorkingDirectoryFileChange>()
        ),
        selectedFileIDs: [],
        diff: null,
        contextualCommitMessage: null,
        commitMessage: null,
        coAuthors: [],
        showCoAuthoredBy: false,
      },
      selectedSection: RepositorySectionTab.Changes,
      branchesState: {
        tip: { kind: TipState.Unknown },
        defaultBranch: null,
        allBranches: new Array<Branch>(),
        recentBranches: new Array<Branch>(),
        openPullRequests: new Array<PullRequest>(),
        currentPullRequest: null,
        isLoadingPullRequests: false,
      },
      compareState: {
        formState: { kind: ComparisonView.None },
        showBranchList: false,
        filterText: '',
        commitSHAs: [],
        aheadBehindCache: new ComparisonCache(),
        allBranches: new Array<Branch>(),
        recentBranches: new Array<Branch>(),
        defaultBranch: null,
      },
      commitAuthor: null,
      gitHubUsers: new Map<string, IGitHubUser>(),
      commitLookup: new Map<string, Commit>(),
      localCommitSHAs: [],
      aheadBehind: null,
      remote: null,
      isPushPullFetchInProgress: false,
      isCommitting: false,
      lastFetched: null,
      checkoutProgress: null,
      pushPullFetchProgress: null,
      revertProgress: null,
    }
  }

  /** Get the state for the repository. */
  public getRepositoryState(repository: Repository): IRepositoryState {
    let state = this.repositoryState.get(repository.hash)
    if (state) {
      const gitHubUsers =
        this.gitHubUserStore.getUsersForRepository(repository) ||
        new Map<string, IGitHubUser>()
      return merge(state, { gitHubUsers })
    }

    state = this.getInitialRepositoryState()
    this.repositoryState.set(repository.hash, state)
    return state
  }

  private updateRepositoryState<K extends keyof IRepositoryState>(
    repository: Repository,
    fn: (state: IRepositoryState) => Pick<IRepositoryState, K>
  ) {
    const currentState = this.getRepositoryState(repository)
    const newValues = fn(currentState)
    this.repositoryState.set(repository.hash, merge(currentState, newValues))
  }

  private updateHistoryState<K extends keyof IHistoryState>(
    repository: Repository,
    fn: (historyState: IHistoryState) => Pick<IHistoryState, K>
  ) {
    this.updateRepositoryState(repository, state => {
      const historyState = state.historyState
      const newValues = fn(historyState)
      return { historyState: merge(historyState, newValues) }
    })
  }

  private updateCompareState<K extends keyof ICompareState>(
    repository: Repository,
    fn: (state: ICompareState) => Pick<ICompareState, K>
  ) {
    this.updateRepositoryState(repository, state => {
      const compareState = state.compareState
      const newValues = fn(compareState)

      return { compareState: merge(compareState, newValues) }
    })
  }

  private updateChangesState<K extends keyof IChangesState>(
    repository: Repository,
    fn: (changesState: IChangesState) => Pick<IChangesState, K>
  ) {
    this.updateRepositoryState(repository, state => {
      const changesState = state.changesState
      const newState = merge(changesState, fn(changesState))
      return { changesState: newState }
    })
  }

  private updateBranchesState<K extends keyof IBranchesState>(
    repository: Repository,
    fn: (branchesState: IBranchesState) => Pick<IBranchesState, K>
  ) {
    this.updateRepositoryState(repository, state => {
      const changesState = state.branchesState
      const newState = merge(changesState, fn(changesState))
      return { branchesState: newState }
    })
  }

  private getSelectedState(): PossibleSelections | null {
    const repository = this.selectedRepository
    if (!repository) {
      return null
    }

    if (repository instanceof CloningRepository) {
      const progress = this.cloningRepositoriesStore.getRepositoryState(
        repository
      )
      if (!progress) {
        return null
      }

      return {
        type: SelectionType.CloningRepository,
        repository,
        progress,
      }
    }

    if (repository.missing) {
      return {
        type: SelectionType.MissingRepository,
        repository,
      }
    }

    return {
      type: SelectionType.Repository,
      repository,
      state: this.getRepositoryState(repository),
    }
  }

  public getState(): IAppState {
    return {
      accounts: this.accounts,
      repositories: [
        ...this.repositories,
        ...this.cloningRepositoriesStore.repositories,
      ],
      windowState: this.windowState,
      windowZoomFactor: this.windowZoomFactor,
      appIsFocused: this.appIsFocused,
      selectedState: this.getSelectedState(),
      signInState: this.signInStore.getState(),
      currentPopup: this.currentPopup,
      currentFoldout: this.currentFoldout,
      errors: this.errors,
      showWelcomeFlow: this.showWelcomeFlow,
      emoji: this.emojiStore.emoji,
      sidebarWidth: this.sidebarWidth,
      commitSummaryWidth: this.commitSummaryWidth,
      appMenuState: this.appMenu ? this.appMenu.openMenus : [],
      titleBarStyle: this.showWelcomeFlow ? 'light' : 'dark',
      highlightAccessKeys: this.highlightAccessKeys,
      isUpdateAvailableBannerVisible: this.isUpdateAvailableBannerVisible,
      askForConfirmationOnRepositoryRemoval: this.confirmRepoRemoval,
      askForConfirmationOnDiscardChanges: this.confirmDiscardChanges,
      selectedExternalEditor: this.selectedExternalEditor,
      imageDiffType: this.imageDiffType,
      selectedShell: this.selectedShell,
      repositoryFilterText: this.repositoryFilterText,
      selectedCloneRepositoryTab: this.selectedCloneRepositoryTab,
      selectedBranchesTab: this.selectedBranchesTab,
      selectedItemsTab: this.selectedItemsTab,
    }
  }

  private onGitStoreUpdated(repository: Repository, gitStore: GitStore) {
    this.updateHistoryState(repository, state => ({
      history: gitStore.history,
    }))

    this.updateBranchesState(repository, state => ({
      tip: gitStore.tip,
      defaultBranch: gitStore.defaultBranch,
      allBranches: gitStore.allBranches,
      recentBranches: gitStore.recentBranches,
    }))

    this.updateChangesState(repository, state => ({
      commitMessage: gitStore.commitMessage,
      contextualCommitMessage: gitStore.contextualCommitMessage,
      showCoAuthoredBy: gitStore.showCoAuthoredBy,
      coAuthors: gitStore.coAuthors,
    }))

    this.updateRepositoryState(repository, state => ({
      commitLookup: gitStore.commitLookup,
      localCommitSHAs: gitStore.localCommitSHAs,
      aheadBehind: gitStore.aheadBehind,
      remote: gitStore.remote,
      lastFetched: gitStore.lastFetched,
    }))

    this.emitUpdate()
  }

  private removeGitStore(repository: Repository) {
    if (this.gitStores.has(repository.hash)) {
      this.gitStores.delete(repository.hash)
    }
  }

  private getGitStore(repository: Repository): GitStore {
    let gitStore = this.gitStores.get(repository.hash)
    if (!gitStore) {
      gitStore = new GitStore(repository, shell)
      gitStore.onDidUpdate(() => this.onGitStoreUpdated(repository, gitStore!))
      gitStore.onDidLoadNewCommits(commits =>
        this.loadAndCacheUsers(repository, this.accounts, commits)
      )
      gitStore.onDidError(error => this.emitError(error))

      this.gitStores.set(repository.hash, gitStore)
    }

    return gitStore
  }

  private removeRepositorySettingsStore(repository: Repository) {
    const key = repository.hash

    if (this.repositorySettingsStores.has(key)) {
      this.repositorySettingsStores.delete(key)
    }
  }

  private getRepositorySettingsStore(
    repository: Repository
  ): RepositorySettingsStore {
    let store = this.repositorySettingsStores.get(repository.hash)

    if (store == null) {
      store = new RepositorySettingsStore(repository)

      store.onDidError(error => this.emitError(error))

      this.repositorySettingsStores.set(repository.hash, store)
    }

    return store
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadHistory(repository: Repository): Promise<void> {
    const gitStore = this.getGitStore(repository)
    await gitStore.loadHistory()

    const state = this.getRepositoryState(repository).historyState
    let newSelection = state.selection
    const history = state.history
    const selectedSHA = state.selection.sha
    if (selectedSHA) {
      const index = history.findIndex(sha => sha === selectedSHA)
      // Our selected SHA disappeared, so clear the selection.
      if (index < 0) {
        newSelection = {
          sha: null,
          file: null,
        }
      }
    }

    if (!newSelection.sha && history.length > 0) {
      this._changeHistoryCommitSelection(repository, history[0])
      this._loadChangedFilesForCurrentSelection(repository)
    }

    this.emitUpdate()
  }

  private startAheadBehindUpdater(repository: Repository) {
    if (this.currentAheadBehindUpdater != null) {
      fatalError(
        `An ahead/behind updater is already active and cannot start updating on ${
          repository.name
        }`
      )

      return
    }

    const updater = new AheadBehindUpdater(repository, aheadBehindCache => {
      this.updateCompareState(repository, state => ({
        aheadBehindCache,
      }))
      this.emitUpdate()
    })

    this.currentAheadBehindUpdater = updater

    this.currentAheadBehindUpdater.start()
  }

  private stopAheadBehindUpdate() {
    const updater = this.currentAheadBehindUpdater

    if (updater != null) {
      updater.stop()
      this.currentAheadBehindUpdater = null
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _initializeCompare(
    repository: Repository,
    initialAction?: CompareAction
  ) {
    log.debug('[AppStore] initializing compare state')

    const state = this.getRepositoryState(repository)

    const branchesState = state.branchesState
    const tip = branchesState.tip
    const currentBranch = tip.kind === TipState.Valid ? tip.branch : null

    const allBranches =
      currentBranch != null
        ? branchesState.allBranches.filter(b => b.name !== currentBranch.name)
        : branchesState.allBranches
    const recentBranches = currentBranch
      ? branchesState.recentBranches.filter(b => b.name !== currentBranch.name)
      : branchesState.recentBranches

    const cachedDefaultBranch = branchesState.defaultBranch

    // only include the default branch when comparing if the user is not on the default branch
    // and it also exists in the repository
    const defaultBranch =
      currentBranch != null &&
      cachedDefaultBranch != null &&
      currentBranch.name !== cachedDefaultBranch.name
        ? cachedDefaultBranch
        : null

    this.updateCompareState(repository, state => ({
      allBranches,
      recentBranches,
      defaultBranch,
    }))

    const compareState = state.compareState

    const cachedState = compareState.formState

    const action =
      initialAction != null ? initialAction : getInitialAction(cachedState)
    this._executeCompare(repository, action)

    if (currentBranch != null && this.currentAheadBehindUpdater != null) {
      this.currentAheadBehindUpdater.schedule(currentBranch, allBranches)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _executeCompare(
    repository: Repository,
    action: CompareAction
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    const kind = action.kind

    if (action.kind === CompareActionKind.History) {
      await gitStore.loadHistory()

      const repoState = this.getRepositoryState(repository).historyState
      const commits = repoState.history

      this.updateCompareState(repository, state => ({
        formState: {
          kind: ComparisonView.None,
        },
        commitSHAs: commits,
      }))
      return this.emitUpdate()
    } else if (action.kind === CompareActionKind.Branch) {
      const comparisonBranch = action.branch
      const compare = await gitStore.getCompareCommits(
        comparisonBranch,
        action.mode
      )

      this.statsStore.recordBranchComparison()
      const { branchesState } = this.getRepositoryState(repository)

      if (
        branchesState.defaultBranch !== null &&
        comparisonBranch.name === branchesState.defaultBranch.name
      ) {
        this.statsStore.recordDefaultBranchComparison()
      }

      if (compare !== null) {
        const { ahead, behind } = compare
        const aheadBehind = { ahead, behind }

        this.updateCompareState(repository, s => ({
          formState: {
            comparisonBranch,
            kind: action.mode,
            aheadBehind,
          },
          commitSHAs: compare.commits.map(commit => commit.sha),
        }))

        const tip = gitStore.tip

        let currentSha: string | null = null

        if (tip.kind === TipState.Valid) {
          currentSha = tip.branch.tip.sha
        } else if (tip.kind === TipState.Detached) {
          currentSha = tip.currentSha
        }

        if (this.currentAheadBehindUpdater != null && currentSha != null) {
          const from =
            action.mode === ComparisonView.Ahead
              ? comparisonBranch.tip.sha
              : currentSha
          const to =
            action.mode === ComparisonView.Ahead
              ? currentSha
              : comparisonBranch.tip.sha

          this.currentAheadBehindUpdater.insert(from, to, aheadBehind)
        }

        return this.emitUpdate()
      }
    } else {
      return assertNever(action, `Unknown action: ${kind}`)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _updateCompareForm<K extends keyof ICompareFormUpdate>(
    repository: Repository,
    newState: Pick<ICompareFormUpdate, K>
  ) {
    this.updateCompareState(repository, state => {
      return merge(state, newState)
    })

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _loadNextHistoryBatch(repository: Repository): Promise<void> {
    const gitStore = this.getGitStore(repository)
    return gitStore.loadNextHistoryBatch()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadChangedFilesForCurrentSelection(
    repository: Repository
  ): Promise<void> {
    const state = this.getRepositoryState(repository)
    const selection = state.historyState.selection
    const currentSHA = selection.sha
    if (!currentSHA) {
      return
    }

    const gitStore = this.getGitStore(repository)
    const changedFiles = await gitStore.performFailableOperation(() =>
      getChangedFiles(repository, currentSHA)
    )
    if (!changedFiles) {
      return
    }

    // The selection could have changed between when we started loading the
    // changed files and we finished. We might wanna store the changed files per
    // SHA/path.
    if (currentSHA !== state.historyState.selection.sha) {
      return
    }

    // if we're selecting a commit for the first time, we should select the
    // first file in the commit and render the diff immediately

    const noFileSelected = selection.file === null

    const firstFileOrDefault =
      noFileSelected && changedFiles.length ? changedFiles[0] : selection.file

    const selectionOrFirstFile = {
      file: firstFileOrDefault,
      sha: selection.sha,
    }

    this.updateHistoryState(repository, state => ({ changedFiles }))

    this.emitUpdate()

    if (selectionOrFirstFile.file) {
      this._changeHistoryFileSelection(repository, selectionOrFirstFile.file)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeHistoryCommitSelection(
    repository: Repository,
    sha: string
  ): Promise<void> {
    this.updateHistoryState(repository, state => {
      const commitChanged = state.selection.sha !== sha
      const changedFiles = commitChanged
        ? new Array<CommittedFileChange>()
        : state.changedFiles
      const file = commitChanged ? null : state.selection.file
      const selection = { sha, file }
      const diff = null

      return { selection, changedFiles, diff }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _setRepositoryFilterText(text: string): Promise<void> {
    this.repositoryFilterText = text
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeHistoryFileSelection(
    repository: Repository,
    file: CommittedFileChange
  ): Promise<void> {
    this.updateHistoryState(repository, state => {
      const selection = { sha: state.selection.sha, file }
      const diff = null
      return { selection, diff }
    })
    this.emitUpdate()

    const stateBeforeLoad = this.getRepositoryState(repository)
    const sha = stateBeforeLoad.historyState.selection.sha

    if (!sha) {
      if (__DEV__) {
        throw new Error(
          "No currently selected sha yet we've been asked to switch file selection"
        )
      } else {
        return
      }
    }

    const diff = await getCommitDiff(repository, file, sha)

    const stateAfterLoad = this.getRepositoryState(repository)

    // A whole bunch of things could have happened since we initiated the diff load
    if (
      stateAfterLoad.historyState.selection.sha !==
      stateBeforeLoad.historyState.selection.sha
    ) {
      return
    }
    if (!stateAfterLoad.historyState.selection.file) {
      return
    }
    if (stateAfterLoad.historyState.selection.file.id !== file.id) {
      return
    }

    this.updateHistoryState(repository, state => {
      const selection = { sha: state.selection.sha, file }
      return { selection, diff }
    })

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _selectRepository(
    repository: Repository | CloningRepository | null
  ): Promise<Repository | null> {
    const previouslySelectedRepository = this.selectedRepository

    this.selectedRepository = repository

    this.emitUpdate()
    this.stopBackgroundFetching()
    this.stopPullRequestUpdater()

    if (repository == null) {
      return Promise.resolve(null)
    }

    if (!(repository instanceof Repository)) {
      return Promise.resolve(null)
    }

    localStorage.setItem(LastSelectedRepositoryIDKey, repository.id.toString())

    if (repository.missing) {
      // as the repository is no longer found on disk, cleaning this up
      // ensures we don't accidentally run any Git operations against the
      // wrong location if the user then relocates the `.git` folder elsewhere
      this.removeGitStore(repository)
      this.removeRepositorySettingsStore(repository)
      return Promise.resolve(null)
    }

    this._refreshRepository(repository)

    const gitHubRepository = repository.gitHubRepository

    if (gitHubRepository != null) {
      this._refreshIssues(gitHubRepository)
      this.loadPullRequests(repository, async () => {
        const promiseForPRs = this.pullRequestStore.fetchPullRequestsFromCache(
          gitHubRepository
        )
        const isLoading = this.pullRequestStore.isFetchingPullRequests(
          gitHubRepository
        )

        const prs = await promiseForPRs

        if (prs.length > 0) {
          this.updateBranchesState(repository, state => {
            return {
              openPullRequests: prs,
              isLoadingPullRequests: isLoading,
            }
          })
        } else {
          this._refreshPullRequests(repository)
        }

        this._updateCurrentPullRequest(repository)
        this.emitUpdate()
      })
    }

    // The selected repository could have changed while we were refreshing.
    if (this.selectedRepository !== repository) {
      return null
    }

    // "Clone in Desktop" from a cold start can trigger this twice, and
    // for edge cases where _selectRepository is re-entract, calling this here
    // ensures we clean up the existing background fetcher correctly (if set)
    this.stopBackgroundFetching()
    this.stopPullRequestUpdater()
    this.stopAheadBehindUpdate()

    this.startBackgroundFetching(repository, !previouslySelectedRepository)
    this.startPullRequestUpdater(repository)

    if (enableCompareSidebar()) {
      this.startAheadBehindUpdater(repository)
    }

    this.refreshMentionables(repository)

    this.addUpstreamRemoteIfNeeded(repository)

    return this._repositoryWithRefreshedGitHubRepository(repository)
  }

  public async _refreshIssues(repository: GitHubRepository) {
    const user = getAccountForEndpoint(this.accounts, repository.endpoint)
    if (!user) {
      return
    }

    try {
      await this._issuesStore.refreshIssues(repository, user)
    } catch (e) {
      log.warn(`Unable to fetch issues for ${repository.fullName}`, e)
    }
  }

  private stopBackgroundFetching() {
    const backgroundFetcher = this.currentBackgroundFetcher
    if (backgroundFetcher) {
      backgroundFetcher.stop()
      this.currentBackgroundFetcher = null
    }
  }

  private refreshMentionables(repository: Repository) {
    const account = getAccountForRepository(this.accounts, repository)
    if (!account) {
      return
    }

    const gitHubRepository = repository.gitHubRepository
    if (!gitHubRepository) {
      return
    }

    this.gitHubUserStore.updateMentionables(gitHubRepository, account)
  }

  private startPullRequestUpdater(repository: Repository) {
    if (this.currentPullRequestUpdater) {
      fatalError(
        `A pull request updater is already active and cannot start updating on ${
          repository.name
        }`
      )

      return
    }

    if (!repository.gitHubRepository) {
      return
    }

    const account = getAccountForRepository(this.accounts, repository)

    if (!account) {
      return
    }

    const updater = new PullRequestUpdater(
      repository,
      account,
      this.pullRequestStore
    )
    this.currentPullRequestUpdater = updater

    this.currentPullRequestUpdater.start()
  }

  private stopPullRequestUpdater() {
    const updater = this.currentPullRequestUpdater

    if (updater) {
      updater.stop()
      this.currentPullRequestUpdater = null
    }
  }

  private shouldBackgroundFetch(repository: Repository): boolean {
    const gitStore = this.getGitStore(repository)
    const lastFetched = gitStore.lastFetched

    if (!lastFetched) {
      return true
    }

    const now = new Date()
    const timeSinceFetch = now.getTime() - lastFetched.getTime()

    if (timeSinceFetch < BackgroundFetchMinimumInterval) {
      const timeInSeconds = Math.floor(timeSinceFetch / 1000)

      log.debug(
        `skipping background fetch as repository was fetched ${timeInSeconds}s ago`
      )
      return false
    }

    return true
  }

  private startBackgroundFetching(
    repository: Repository,
    withInitialSkew: boolean
  ) {
    if (this.currentBackgroundFetcher) {
      fatalError(
        `We should only have on background fetcher active at once, but we're trying to start background fetching on ${
          repository.name
        } while another background fetcher is still active!`
      )
      return
    }

    const account = getAccountForRepository(this.accounts, repository)
    if (!account) {
      return
    }

    if (!repository.gitHubRepository) {
      return
    }

    const fetcher = new BackgroundFetcher(
      repository,
      account,
      r => this.performFetch(r, account, FetchType.BackgroundTask),
      r => this.shouldBackgroundFetch(r)
    )
    fetcher.start(withInitialSkew)
    this.currentBackgroundFetcher = fetcher
  }

  /** Load the initial state for the app. */
  public async loadInitialState() {
    const [accounts, repositories] = await Promise.all([
      this.accountsStore.getAll(),
      this.repositoriesStore.getAll(),
    ])

    log.info(
      `[AppStore] loading ${repositories.length} repositories from store`
    )
    accounts.forEach(a => {
      log.info(`[AppStore] found account: ${a.login} (${a.name})`)
    })

    this.accounts = accounts
    this.repositories = repositories

    // doing this that the current user can be found by any of their email addresses
    for (const account of accounts) {
      const userAssociations: ReadonlyArray<IGitHubUser> = account.emails.map(
        email =>
          // NB: We're not using object spread here because `account` has more
          // keys than we want.
          ({
            endpoint: account.endpoint,
            email: email.email,
            login: account.login,
            avatarURL: account.avatarURL,
            name: account.name,
          })
      )

      for (const user of userAssociations) {
        this.gitHubUserStore.cacheUser(user)
      }
    }

    this.updateRepositorySelectionAfterRepositoriesChanged()

    this.sidebarWidth =
      parseInt(localStorage.getItem(sidebarWidthConfigKey) || '', 10) ||
      defaultSidebarWidth
    this.commitSummaryWidth =
      parseInt(localStorage.getItem(commitSummaryWidthConfigKey) || '', 10) ||
      defaultCommitSummaryWidth

    const confirmRepositoryRemovalValue = localStorage.getItem(
      confirmRepoRemovalKey
    )

    this.confirmRepoRemoval =
      confirmRepositoryRemovalValue === null
        ? confirmRepoRemovalDefault
        : confirmRepositoryRemovalValue === '1'

    const confirmDiscardChangesValue = localStorage.getItem(
      confirmDiscardChangesKey
    )

    this.confirmDiscardChanges =
      confirmDiscardChangesValue === null
        ? confirmDiscardChangesDefault
        : confirmDiscardChangesValue === '1'

    const externalEditorValue = await this.getSelectedExternalEditor()
    if (externalEditorValue) {
      this.selectedExternalEditor = externalEditorValue
    }

    const shellValue = localStorage.getItem(shellKey)
    this.selectedShell = shellValue ? parseShell(shellValue) : DefaultShell

    this.updateMenuItemLabels()

    const imageDiffTypeValue = localStorage.getItem(imageDiffTypeKey)
    this.imageDiffType =
      imageDiffTypeValue === null
        ? imageDiffTypeDefault
        : parseInt(imageDiffTypeValue)

    this.emitUpdateNow()

    this.accountsStore.refresh()
  }

  private async getSelectedExternalEditor(): Promise<ExternalEditor | null> {
    const externalEditorValue = localStorage.getItem(externalEditorKey)
    if (externalEditorValue) {
      const value = parse(externalEditorValue)
      if (value) {
        return value
      }
    }

    const editors = await getAvailableEditors()
    if (editors.length) {
      const value = editors[0].editor
      // store this value to avoid the lookup next time
      localStorage.setItem(externalEditorKey, value)
      return value
    }

    return null
  }

  /**
   * Update menu labels for editor, shell, and pull requests.
   */
  private updateMenuItemLabels(repository?: Repository) {
    const editorLabel = this.selectedExternalEditor
      ? `Open in ${this.selectedExternalEditor}`
      : undefined

    const prLabel = repository
      ? this.getPullRequestLabel(repository)
      : undefined

    updatePreferredAppMenuItemLabels({
      editor: editorLabel,
      pullRequestLabel: prLabel,
      shell: `Open in ${this.selectedShell}`,
    })
  }

  private getPullRequestLabel(repository: Repository) {
    const githubRepository = repository.gitHubRepository
    const defaultPRLabel = __DARWIN__
      ? 'Create Pull Request'
      : 'Create &pull request'

    if (!githubRepository) {
      return defaultPRLabel
    }

    const repositoryState = this.repositoryState.get(repository.hash)

    if (!repositoryState) {
      return defaultPRLabel
    }

    const branchState = repositoryState.branchesState

    if (!branchState.currentPullRequest) {
      return defaultPRLabel
    }

    return __DARWIN__ ? 'Show Pull Request' : 'Show &pull request'
  }

  private updateRepositorySelectionAfterRepositoriesChanged() {
    const selectedRepository = this.selectedRepository
    let newSelectedRepository: Repository | CloningRepository | null = this
      .selectedRepository
    if (selectedRepository) {
      const r =
        this.repositories.find(
          r =>
            r.constructor === selectedRepository.constructor &&
            r.id === selectedRepository.id
        ) || null

      newSelectedRepository = r
    }

    if (newSelectedRepository === null && this.repositories.length > 0) {
      const lastSelectedID = parseInt(
        localStorage.getItem(LastSelectedRepositoryIDKey) || '',
        10
      )
      if (lastSelectedID && !isNaN(lastSelectedID)) {
        newSelectedRepository =
          this.repositories.find(r => r.id === lastSelectedID) || null
      }

      if (!newSelectedRepository) {
        newSelectedRepository = this.repositories[0]
      }
    }

    const repositoryChanged =
      (selectedRepository &&
        newSelectedRepository &&
        selectedRepository.hash !== newSelectedRepository.hash) ||
      (selectedRepository && !newSelectedRepository) ||
      (!selectedRepository && newSelectedRepository)
    if (repositoryChanged) {
      this._selectRepository(newSelectedRepository)
      this.emitUpdate()
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadStatus(
    repository: Repository,
    clearPartialState: boolean = false
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    const status = await gitStore.loadStatus()

    if (!status) {
      return
    }

    this.updateChangesState(repository, state => {
      // Populate a map for all files in the current working directory state
      const filesByID = new Map<string, WorkingDirectoryFileChange>()
      state.workingDirectory.files.forEach(f => filesByID.set(f.id, f))

      // Attempt to preserve the selection state for each file in the new
      // working directory state by looking at the current files
      const mergedFiles = status.workingDirectory.files
        .map(file => {
          const existingFile = filesByID.get(file.id)
          if (existingFile) {
            if (clearPartialState) {
              if (
                existingFile.selection.getSelectionType() ===
                DiffSelectionType.Partial
              ) {
                return file.withIncludeAll(false)
              }
            }

            return file.withSelection(existingFile.selection)
          } else {
            return file
          }
        })
        .sort((x, y) => caseInsensitiveCompare(x.path, y.path))

      // Collect all the currently available file ids into a set to avoid O(N)
      // lookups using .find on the mergedFiles array.
      const mergedFileIds = new Set(mergedFiles.map(x => x.id))

      // The previously selected files might not be available in the working
      // directory any more due to having been committed or discarded so we'll
      // do a pass over and filter out any selected files that aren't available.
      let selectedFileIDs = state.selectedFileIDs.filter(id =>
        mergedFileIds.has(id)
      )

      // Select the first file if we don't have anything selected and we
      // have something to select.
      if (selectedFileIDs.length === 0 && mergedFiles.length > 0) {
        selectedFileIDs = [mergedFiles[0].id]
      }

      // The file selection could have changed if the previously selected files
      // are no longer selectable (they were discarded or committed) but if they
      // were not changed we can reuse the diff. Note, however that we only render
      // a diff when a single file is selected. If the previous selection was
      // a single file with the same id as the current selection we can keep the
      // diff we had, if not we'll clear it.
      const workingDirectory = WorkingDirectoryStatus.fromFiles(mergedFiles)

      const diff =
        selectedFileIDs.length === 1 &&
        state.selectedFileIDs.length === 1 &&
        state.selectedFileIDs[0] === selectedFileIDs[0]
          ? state.diff
          : null

      return { workingDirectory, selectedFileIDs, diff }
    })
    this.emitUpdate()

    this.updateChangesDiffForCurrentSelection(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeRepositorySection(
    repository: Repository,
    selectedSection: RepositorySectionTab
  ): Promise<void> {
    this.updateRepositoryState(repository, state => ({ selectedSection }))
    this.emitUpdate()

    if (selectedSection === RepositorySectionTab.History) {
      return this.refreshHistorySection(repository)
    } else if (selectedSection === RepositorySectionTab.Changes) {
      return this.refreshChangesSection(repository, {
        includingStatus: true,
        clearPartialState: false,
      })
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeChangesSelection(
    repository: Repository,
    selectedFiles: WorkingDirectoryFileChange[]
  ): Promise<void> {
    this.updateChangesState(repository, state => ({
      selectedFileIDs: selectedFiles.map(file => file.id),
      diff: null,
    }))
    this.emitUpdate()

    this.updateChangesDiffForCurrentSelection(repository)
  }

  /**
   * Loads or re-loads (refreshes) the diff for the currently selected file
   * in the working directory. This operation is a noop if there's no currently
   * selected file.
   */
  private async updateChangesDiffForCurrentSelection(
    repository: Repository
  ): Promise<void> {
    const stateBeforeLoad = this.getRepositoryState(repository)
    const changesStateBeforeLoad = stateBeforeLoad.changesState
    const selectedFileIDsBeforeLoad = changesStateBeforeLoad.selectedFileIDs

    // We only render diffs when a single file is selected.
    if (selectedFileIDsBeforeLoad.length !== 1) {
      if (changesStateBeforeLoad.diff !== null) {
        this.updateChangesState(repository, state => ({ diff: null }))
        this.emitUpdate()
      }
      return
    }

    const selectedFileIdBeforeLoad = selectedFileIDsBeforeLoad[0]
    const selectedFileBeforeLoad = changesStateBeforeLoad.workingDirectory.findFileWithID(
      selectedFileIdBeforeLoad
    )

    if (selectedFileBeforeLoad === null) {
      return
    }

    const diff = await getWorkingDirectoryDiff(
      repository,
      selectedFileBeforeLoad
    )

    const stateAfterLoad = this.getRepositoryState(repository)
    const changesState = stateAfterLoad.changesState

    // A different file (or files) could have been selected while we were
    // loading the diff in which case we no longer care about the diff we
    // just loaded.
    if (changesState.selectedFileIDs.length !== 1) {
      return
    }

    const selectedFileID = changesState.selectedFileIDs[0]

    if (selectedFileID !== selectedFileIdBeforeLoad) {
      return
    }

    const currentlySelectedFile = changesState.workingDirectory.findFileWithID(
      selectedFileID
    )
    if (currentlySelectedFile === null) {
      return
    }

    const selectableLines = new Set<number>()
    if (diff.kind === DiffType.Text) {
      // The diff might have changed dramatically since last we loaded it.
      // Ideally we would be more clever about validating that any partial
      // selection state is still valid by ensuring that selected lines still
      // exist but for now we'll settle on just updating the selectable lines
      // such that any previously selected line which now no longer exists or
      // has been turned into a context line isn't still selected.
      diff.hunks.forEach(h => {
        h.lines.forEach((line, index) => {
          if (line.isIncludeableLine()) {
            selectableLines.add(h.unifiedDiffStart + index)
          }
        })
      })
    }

    const newSelection = currentlySelectedFile.selection.withSelectableLines(
      selectableLines
    )
    const selectedFile = currentlySelectedFile.withSelection(newSelection)
    const updatedFiles = changesState.workingDirectory.files.map(
      f => (f.id === selectedFile.id ? selectedFile : f)
    )
    const workingDirectory = WorkingDirectoryStatus.fromFiles(updatedFiles)

    this.updateChangesState(repository, state => ({ diff, workingDirectory }))
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _commitIncludedChanges(
    repository: Repository,
    summary: string,
    description: string | null,
    trailers?: ReadonlyArray<ITrailer>
  ): Promise<boolean> {
    const state = this.getRepositoryState(repository)
    const files = state.changesState.workingDirectory.files
    const selectedFiles = files.filter(file => {
      return file.selection.getSelectionType() !== DiffSelectionType.None
    })

    const gitStore = this.getGitStore(repository)

    const result = await this.isCommitting(repository, () => {
      return gitStore.performFailableOperation(async () => {
        const message = await formatCommitMessage(
          repository,
          summary,
          description,
          trailers
        )
        return createCommit(repository, message, selectedFiles)
      })
    })

    if (result) {
      this.statsStore.recordCommit()

      const includedPartialSelections = files.some(
        file => file.selection.getSelectionType() === DiffSelectionType.Partial
      )
      if (includedPartialSelections) {
        this.statsStore.recordPartialCommit()
      }

      if (trailers != null && trailers.some(isCoAuthoredByTrailer)) {
        this.statsStore.recordCoAuthoredCommit()
      }

      await this._refreshRepository(repository)
      await this.refreshChangesSection(repository, {
        includingStatus: true,
        clearPartialState: true,
      })
    }

    return result || false
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeFileIncluded(
    repository: Repository,
    file: WorkingDirectoryFileChange,
    include: boolean
  ): Promise<void> {
    const selection = include
      ? file.selection.withSelectAll()
      : file.selection.withSelectNone()
    this.updateWorkingDirectoryFileSelection(repository, file, selection)
    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeFileLineSelection(
    repository: Repository,
    file: WorkingDirectoryFileChange,
    diffSelection: DiffSelection
  ): Promise<void> {
    this.updateWorkingDirectoryFileSelection(repository, file, diffSelection)
    return Promise.resolve()
  }

  /**
   * Updates the selection for the given file in the working directory state and
   * emits an update event.
   */
  private updateWorkingDirectoryFileSelection(
    repository: Repository,
    file: WorkingDirectoryFileChange,
    selection: DiffSelection
  ) {
    this.updateChangesState(repository, state => {
      const newFiles = state.workingDirectory.files.map(
        f => (f.id === file.id ? f.withSelection(selection) : f)
      )

      const workingDirectory = WorkingDirectoryStatus.fromFiles(newFiles)

      return { workingDirectory }
    })

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeIncludeAllFiles(
    repository: Repository,
    includeAll: boolean
  ): Promise<void> {
    this.updateChangesState(repository, state => {
      const workingDirectory = state.workingDirectory.withIncludeAllFiles(
        includeAll
      )
      return { workingDirectory }
    })

    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _refreshRepository(repository: Repository): Promise<void> {
    if (repository.missing) {
      return
    }

    const state = this.getRepositoryState(repository)
    const gitStore = this.getGitStore(repository)

    // When refreshing we *always* check the status so that we can update the
    // changes indicator in the tab bar. But we only load History if it's
    // selected.
    await Promise.all([this._loadStatus(repository), gitStore.loadBranches()])

    const section = state.selectedSection
    let refreshSectionPromise: Promise<void>

    if (section === RepositorySectionTab.History) {
      refreshSectionPromise = this.refreshHistorySection(repository)
    } else if (section === RepositorySectionTab.Changes) {
      refreshSectionPromise = this.refreshChangesSection(repository, {
        includingStatus: false,
        clearPartialState: false,
      })
    } else {
      return assertNever(section, `Unknown section: ${section}`)
    }

    await Promise.all([
      gitStore.loadRemotes(),
      gitStore.updateLastFetched(),
      this.refreshAuthor(repository),
      gitStore.loadContextualCommitMessage(),
      refreshSectionPromise,
    ])

    this._updateCurrentPullRequest(repository)
    this.updateMenuItemLabels(repository)
    this._initializeCompare(repository)
  }

  /**
   * Refresh all the data for the Changes section.
   *
   * This will be called automatically when appropriate.
   */
  private async refreshChangesSection(
    repository: Repository,
    options: { includingStatus: boolean; clearPartialState: boolean }
  ): Promise<void> {
    if (options.includingStatus) {
      await this._loadStatus(repository, options.clearPartialState)
    }

    const gitStore = this.getGitStore(repository)
    const state = this.getRepositoryState(repository)

    if (state.branchesState.tip.kind === TipState.Valid) {
      const currentBranch = state.branchesState.tip.branch
      await gitStore.loadLocalCommits(currentBranch)
    } else if (state.branchesState.tip.kind === TipState.Unborn) {
      await gitStore.loadLocalCommits(null)
    }
  }

  /**
   * Refresh all the data for the History section.
   *
   * This will be called automatically when appropriate.
   */
  private async refreshHistorySection(repository: Repository): Promise<void> {
    const gitStore = this.getGitStore(repository)
    const state = this.getRepositoryState(repository)
    const tip = state.branchesState.tip

    if (tip.kind === TipState.Valid) {
      await gitStore.loadLocalCommits(tip.branch)
    }

    return this._loadHistory(repository)
  }

  private async refreshAuthor(repository: Repository): Promise<void> {
    const gitStore = this.getGitStore(repository)
    const commitAuthor =
      (await gitStore.performFailableOperation(() =>
        getAuthorIdentity(repository)
      )) || null

    this.updateRepositoryState(repository, state => ({ commitAuthor }))
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _showPopup(popup: Popup): Promise<void> {
    this._closePopup()

    // Always close the app menu when showing a pop up. This is only
    // applicable on Windows where we draw a custom app menu.
    this._closeFoldout(FoldoutType.AppMenu)

    this.currentPopup = popup
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _closePopup(): Promise<void> {
    const currentPopup = this.currentPopup
    if (currentPopup == null) {
      return Promise.resolve()
    }

    if (currentPopup.type === PopupType.CloneRepository) {
      this._completeOpenInDesktop(() => Promise.resolve(null))
    }

    this.currentPopup = null
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _showFoldout(foldout: Foldout): Promise<void> {
    this.currentFoldout = foldout
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _closeCurrentFoldout(): Promise<void> {
    if (this.currentFoldout == null) {
      return
    }

    this.currentFoldout = null
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _closeFoldout(foldout: FoldoutType): Promise<void> {
    if (this.currentFoldout == null) {
      return
    }

    if (foldout !== undefined && this.currentFoldout.type !== foldout) {
      return
    }

    this.currentFoldout = null
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _createBranch(
    repository: Repository,
    name: string,
    startPoint?: string
  ): Promise<Repository> {
    const gitStore = this.getGitStore(repository)
    const branch = await gitStore.performFailableOperation(() =>
      createBranch(repository, name, startPoint)
    )

    if (branch == null) {
      return repository
    }

    return await this._checkoutBranch(repository, branch)
  }

  private updateCheckoutProgress(
    repository: Repository,
    checkoutProgress: ICheckoutProgress | null
  ) {
    this.updateRepositoryState(repository, state => ({ checkoutProgress }))

    if (this.selectedRepository === repository) {
      this.emitUpdate()
    }
  }

  private getLocalBranch(
    repository: Repository,
    branch: string
  ): Branch | null {
    const gitStore = this.getGitStore(repository)
    return (
      gitStore.allBranches.find(b => b.nameWithoutRemote === branch) || null
    )
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _checkoutBranch(
    repository: Repository,
    branch: Branch | string
  ): Promise<Repository> {
    const gitStore = this.getGitStore(repository)
    const kind = 'checkout'

    const foundBranch =
      typeof branch === 'string'
        ? this.getLocalBranch(repository, branch)
        : branch

    if (foundBranch == null) {
      return repository
    }

    await this.withAuthenticatingUser(repository, (repository, account) =>
      gitStore.performFailableOperation(() =>
        checkoutBranch(repository, account, foundBranch, progress => {
          this.updateCheckoutProgress(repository, progress)
        })
      )
    )

    try {
      this.updateCheckoutProgress(repository, {
        kind,
        title: __DARWIN__ ? 'Refreshing Repository' : 'Refreshing repository',
        value: 1,
        targetBranch: foundBranch.name,
      })

      await this._refreshRepository(repository)
    } finally {
      this.updateCheckoutProgress(repository, null)
      this._initializeCompare(repository, { kind: CompareActionKind.History })
    }

    return repository
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _repositoryWithRefreshedGitHubRepository(
    repository: Repository
  ): Promise<Repository> {
    const oldGitHubRepository = repository.gitHubRepository

    const matchedGitHubRepository = await this.matchGitHubRepository(repository)
    if (!matchedGitHubRepository) {
      // TODO: We currently never clear GitHub repository associations (see
      // https://github.com/desktop/desktop/issues/1144). So we can bail early
      // at this point.
      return repository
    }

    // This is the repository with the GitHub repository as matched. It's not
    // ideal because the GitHub repository hasn't been fetched from the API yet
    // and so it is incomplete. But if we _can't_ fetch it from the API, it's
    // better than nothing.
    const skeletonOwner = new Owner(
      matchedGitHubRepository.owner,
      matchedGitHubRepository.endpoint,
      null
    )
    const skeletonGitHubRepository = new GitHubRepository(
      matchedGitHubRepository.name,
      skeletonOwner,
      null
    )
    const skeletonRepository = new Repository(
      repository.path,
      repository.id,
      skeletonGitHubRepository,
      repository.missing
    )

    const account = getAccountForEndpoint(
      this.accounts,
      matchedGitHubRepository.endpoint
    )
    if (!account) {
      // If the repository given to us had a GitHubRepository instance we want
      // to try to preserve that if possible since the updated GitHubRepository
      // instance won't have any API information while the previous one might.
      // We'll only swap it out if the endpoint has changed in which case the
      // old API information will be invalid anyway.
      if (
        !oldGitHubRepository ||
        matchedGitHubRepository.endpoint !== oldGitHubRepository.endpoint
      ) {
        return skeletonRepository
      }

      return repository
    }

    const api = API.fromAccount(account)
    const apiRepo = await api.fetchRepository(
      matchedGitHubRepository.owner,
      matchedGitHubRepository.name
    )

    if (!apiRepo) {
      // This is the same as above. If the request fails, we wanna preserve the
      // existing GitHub repository info. But if we didn't have a GitHub
      // repository already or the endpoint changed, the skeleton repository is
      // better than nothing.
      if (
        !oldGitHubRepository ||
        matchedGitHubRepository.endpoint !== oldGitHubRepository.endpoint
      ) {
        return skeletonRepository
      }

      return repository
    }

    const endpoint = matchedGitHubRepository.endpoint
    return this.repositoriesStore.updateGitHubRepository(
      repository,
      endpoint,
      apiRepo
    )
  }

  private async matchGitHubRepository(
    repository: Repository
  ): Promise<IMatchedGitHubRepository | null> {
    const remote = await getDefaultRemote(repository)
    return remote ? matchGitHubRepository(this.accounts, remote.url) : null
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _pushError(error: Error): Promise<void> {
    const newErrors = Array.from(this.errors)
    newErrors.push(error)
    this.errors = newErrors
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _clearError(error: Error): Promise<void> {
    this.errors = this.errors.filter(e => e !== error)
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _renameBranch(
    repository: Repository,
    branch: Branch,
    newName: string
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    await gitStore.performFailableOperation(() =>
      renameBranch(repository, branch, newName)
    )

    return this._refreshRepository(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _deleteBranch(
    repository: Repository,
    branch: Branch,
    includeRemote: boolean
  ): Promise<void> {
    return this.withAuthenticatingUser(repository, async (repo, account) => {
      const defaultBranch = this.getRepositoryState(repository).branchesState
        .defaultBranch
      if (!defaultBranch) {
        throw new Error(`No default branch!`)
      }

      const gitStore = this.getGitStore(repository)

      await gitStore.performFailableOperation(() =>
        checkoutBranch(repository, account, defaultBranch)
      )
      await gitStore.performFailableOperation(() =>
        deleteBranch(repository, branch, account, includeRemote)
      )

      return this._refreshRepository(repository)
    })
  }

  private updatePushPullFetchProgress(
    repository: Repository,
    pushPullFetchProgress: Progress | null
  ) {
    this.updateRepositoryState(repository, state => ({ pushPullFetchProgress }))

    if (this.selectedRepository === repository) {
      this.emitUpdate()
    }
  }

  public async _push(repository: Repository): Promise<void> {
    return this.withAuthenticatingUser(repository, (repository, account) => {
      return this.performPush(repository, account)
    })
  }

  private async performPush(
    repository: Repository,
    account: IGitAccount | null
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    const remote = gitStore.remote
    if (!remote) {
      this._showPopup({ type: PopupType.PublishRepository, repository })
      return
    }

    return this.withPushPull(repository, async () => {
      const state = this.getRepositoryState(repository)
      if (state.branchesState.tip.kind === TipState.Unborn) {
        throw new Error('The current branch is unborn.')
      }

      if (state.branchesState.tip.kind === TipState.Detached) {
        throw new Error('The current repository is in a detached HEAD state.')
      }

      if (state.branchesState.tip.kind === TipState.Valid) {
        const branch = state.branchesState.tip.branch

        const pushTitle = `Pushing to ${remote.name}`

        // Emit an initial progress even before our push begins
        // since we're doing some work to get remotes up front.
        this.updatePushPullFetchProgress(repository, {
          kind: 'push',
          title: pushTitle,
          value: 0,
          remote: remote.name,
          branch: branch.name,
        })

        // Let's say that a push takes roughly twice as long as a fetch,
        // this is of course highly inaccurate.
        let pushWeight = 2.5
        let fetchWeight = 1

        // Let's leave 10% at the end for refreshing
        const refreshWeight = 0.1

        // Scale pull and fetch weights to be between 0 and 0.9.
        const scale = (1 / (pushWeight + fetchWeight)) * (1 - refreshWeight)

        pushWeight *= scale
        fetchWeight *= scale

        const retryAction: RetryAction = {
          type: RetryActionType.Push,
          repository,
        }
        await gitStore.performFailableOperation(
          async () => {
            await pushRepo(
              repository,
              account,
              remote.name,
              branch.name,
              branch.upstreamWithoutRemote,
              progress => {
                this.updatePushPullFetchProgress(repository, {
                  ...progress,
                  title: pushTitle,
                  value: pushWeight * progress.value,
                })
              }
            )

            await gitStore.fetchRemotes(
              account,
              [remote],
              false,
              fetchProgress => {
                this.updatePushPullFetchProgress(repository, {
                  ...fetchProgress,
                  value: pushWeight + fetchProgress.value * fetchWeight,
                })
              }
            )

            const refreshTitle = __DARWIN__
              ? 'Refreshing Repository'
              : 'Refreshing repository'
            const refreshStartProgress = pushWeight + fetchWeight

            this.updatePushPullFetchProgress(repository, {
              kind: 'generic',
              title: refreshTitle,
              value: refreshStartProgress,
            })

            await this._refreshRepository(repository)

            this.updatePushPullFetchProgress(repository, {
              kind: 'generic',
              title: refreshTitle,
              description: 'Fast-forwarding branches',
              value: refreshStartProgress + refreshWeight * 0.5,
            })

            await this.fastForwardBranches(repository)
          },
          { retryAction }
        )

        this.updatePushPullFetchProgress(repository, null)

        const prUpdater = this.currentPullRequestUpdater
        if (prUpdater) {
          const state = this.getRepositoryState(repository)
          const currentPR = state.branchesState.currentPullRequest
          const gitHubRepository = repository.gitHubRepository

          if (currentPR && gitHubRepository) {
            prUpdater.didPushPullRequest(currentPR)
          }
        }
      }
    })
  }

  private async isCommitting(
    repository: Repository,
    fn: () => Promise<boolean | undefined>
  ): Promise<boolean | undefined> {
    const state = this.getRepositoryState(repository)
    // ensure the user doesn't try and commit again
    if (state.isCommitting) {
      return
    }

    this.updateRepositoryState(repository, state => ({ isCommitting: true }))
    this.emitUpdate()

    try {
      return await fn()
    } finally {
      this.updateRepositoryState(repository, state => ({ isCommitting: false }))
      this.emitUpdate()
    }
  }

  private async withPushPull(
    repository: Repository,
    fn: () => Promise<void>
  ): Promise<void> {
    const state = this.getRepositoryState(repository)
    // Don't allow concurrent network operations.
    if (state.isPushPullFetchInProgress) {
      return
    }

    this.updateRepositoryState(repository, state => ({
      isPushPullFetchInProgress: true,
    }))
    this.emitUpdate()

    try {
      await fn()
    } finally {
      this.updateRepositoryState(repository, state => ({
        isPushPullFetchInProgress: false,
      }))
      this.emitUpdate()
    }
  }

  public async _pull(repository: Repository): Promise<void> {
    return this.withAuthenticatingUser(repository, (repository, account) => {
      return this.performPull(repository, account)
    })
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  private async performPull(
    repository: Repository,
    account: IGitAccount | null
  ): Promise<void> {
    return this.withPushPull(repository, async () => {
      const gitStore = this.getGitStore(repository)
      const remote = gitStore.remote

      if (!remote) {
        throw new Error('The repository has no remotes.')
      }

      const state = this.getRepositoryState(repository)
      const tip = state.branchesState.tip

      if (tip.kind === TipState.Unborn) {
        throw new Error('The current branch is unborn.')
      }

      if (tip.kind === TipState.Detached) {
        throw new Error('The current repository is in a detached HEAD state.')
      }

      if (tip.kind === TipState.Valid) {
        let mergeBase: string | null = null
        if (tip.branch.upstream) {
          mergeBase = await getMergeBase(
            repository,
            tip.branch.name,
            tip.branch.upstream
          )
        }

        const title = `Pulling ${remote.name}`
        const kind = 'pull'
        this.updatePushPullFetchProgress(repository, {
          kind,
          title,
          value: 0,
          remote: remote.name,
        })

        try {
          // Let's say that a pull takes twice as long as a fetch,
          // this is of course highly inaccurate.
          let pullWeight = 2
          let fetchWeight = 1

          // Let's leave 10% at the end for refreshing
          const refreshWeight = 0.1

          // Scale pull and fetch weights to be between 0 and 0.9.
          const scale = (1 / (pullWeight + fetchWeight)) * (1 - refreshWeight)

          pullWeight *= scale
          fetchWeight *= scale

          const retryAction: RetryAction = {
            type: RetryActionType.Pull,
            repository,
          }
          await gitStore.performFailableOperation(
            () =>
              pullRepo(repository, account, remote.name, progress => {
                this.updatePushPullFetchProgress(repository, {
                  ...progress,
                  value: progress.value * pullWeight,
                })
              }),
            { retryAction }
          )

          const refreshStartProgress = pullWeight + fetchWeight
          const refreshTitle = __DARWIN__
            ? 'Refreshing Repository'
            : 'Refreshing repository'

          this.updatePushPullFetchProgress(repository, {
            kind: 'generic',
            title: refreshTitle,
            value: refreshStartProgress,
          })

          if (mergeBase) {
            await gitStore.reconcileHistory(mergeBase)
          }

          await this._refreshRepository(repository)

          this.updatePushPullFetchProgress(repository, {
            kind: 'generic',
            title: refreshTitle,
            description: 'Fast-forwarding branches',
            value: refreshStartProgress + refreshWeight * 0.5,
          })

          await this.fastForwardBranches(repository)
        } finally {
          this.updatePushPullFetchProgress(repository, null)
        }
      }
    })
  }

  private async fastForwardBranches(repository: Repository) {
    const state = this.getRepositoryState(repository)
    const branches = state.branchesState.allBranches

    const tip = state.branchesState.tip
    const currentBranchName =
      tip.kind === TipState.Valid ? tip.branch.name : null

    let eligibleBranches = branches.filter(b =>
      eligibleForFastForward(b, currentBranchName)
    )

    if (eligibleBranches.length >= FastForwardBranchesThreshold) {
      log.info(
        `skipping fast-forward for all branches as there are ${
          eligibleBranches.length
        } local branches - this will run again when there are less than ${FastForwardBranchesThreshold} local branches tracking remotes`
      )

      const defaultBranch = state.branchesState.defaultBranch
      eligibleBranches =
        defaultBranch != null &&
        eligibleForFastForward(defaultBranch, currentBranchName)
          ? [defaultBranch]
          : []
    }

    for (const branch of eligibleBranches) {
      const aheadBehind = await getBranchAheadBehind(repository, branch)
      if (!aheadBehind) {
        continue
      }

      const { ahead, behind } = aheadBehind
      // Only perform the fast forward if the branch is behind it's upstream
      // branch and has no local commits.
      if (ahead === 0 && behind > 0) {
        // At this point we're guaranteed this is non-null since we've filtered
        // out any branches will null upstreams above when creating
        // `eligibleBranches`.
        const upstreamRef = branch.upstream!
        const localRef = formatAsLocalRef(branch.name)
        await updateRef(
          repository,
          localRef,
          branch.tip.sha,
          upstreamRef,
          'pull: Fast-forward'
        )
      }
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _publishRepository(
    repository: Repository,
    name: string,
    description: string,
    private_: boolean,
    account: Account,
    org: IAPIUser | null
  ): Promise<Repository> {
    const api = API.fromAccount(account)
    const apiRepository = await api.createRepository(
      org,
      name,
      description,
      private_
    )

    const gitStore = this.getGitStore(repository)
    await gitStore.performFailableOperation(() =>
      addRemote(repository, 'origin', apiRepository.clone_url)
    )
    await gitStore.loadRemotes()

    // skip pushing if the current branch is a detached HEAD or the repository
    // is unborn
    if (gitStore.tip.kind === TipState.Valid) {
      await this.performPush(repository, account)
    }

    return this._repositoryWithRefreshedGitHubRepository(repository)
  }

  private getAccountForRemoteURL(remote: string): IGitAccount | null {
    const gitHubRepository = matchGitHubRepository(this.accounts, remote)
    if (gitHubRepository) {
      const account = getAccountForEndpoint(
        this.accounts,
        gitHubRepository.endpoint
      )
      if (account) {
        const hasValidToken =
          account.token.length > 0 ? 'has token' : 'empty token'
        log.info(
          `[AppStore.getAccountForRemoteURL] account found for remote: ${remote} - ${
            account.login
          } (${hasValidToken})`
        )
        return account
      }
    }

    const hostname = getGenericHostname(remote)
    const username = getGenericUsername(hostname)
    if (username != null) {
      log.info(
        `[AppStore.getAccountForRemoteURL] found generic credentials for '${hostname}' and '${username}'`
      )
      return { login: username, endpoint: hostname }
    }

    log.info(
      `[AppStore.getAccountForRemoteURL] no generic credentials found for '${remote}'`
    )

    return null
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _clone(
    url: string,
    path: string,
    options?: { branch?: string }
  ): { promise: Promise<boolean>; repository: CloningRepository } {
    const account = this.getAccountForRemoteURL(url)
    const promise = this.cloningRepositoriesStore.clone(url, path, {
      ...options,
      account,
    })
    const repository = this.cloningRepositoriesStore.repositories.find(
      r => r.url === url && r.path === path
    )!

    return { promise, repository }
  }

  public _removeCloningRepository(repository: CloningRepository) {
    this.cloningRepositoriesStore.remove(repository)
  }

  public async _discardChanges(
    repository: Repository,
    files: ReadonlyArray<WorkingDirectoryFileChange>
  ) {
    const gitStore = this.getGitStore(repository)
    await gitStore.discardChanges(files)

    return this._refreshRepository(repository)
  }

  public async _undoCommit(
    repository: Repository,
    commit: Commit
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)

    await gitStore.undoCommit(commit)

    const state = this.getRepositoryState(repository)
    const selectedCommit = state.historyState.selection.sha

    if (selectedCommit === commit.sha) {
      // clear the selection of this commit in the history view
      this.updateHistoryState(repository, state => {
        const selection = { sha: null, file: null }
        return { selection }
      })
    }

    return this._refreshRepository(repository)
  }

  /**
   * Fetch a specific refspec for the repository.
   *
   * As this action is required to complete when viewing a Pull Request from
   * a fork, it does not opt-in to checks that prevent multiple concurrent
   * network actions. This might require some rework in the future to chain
   * these actions.
   *
   */
  public async _fetchRefspec(
    repository: Repository,
    refspec: string
  ): Promise<void> {
    return this.withAuthenticatingUser(
      repository,
      async (repository, account) => {
        const gitStore = this.getGitStore(repository)
        await gitStore.fetchRefspec(account, refspec)

        return this._refreshRepository(repository)
      }
    )
  }

  /**
   * Fetch all relevant remotes in the the repository.
   *
   * See gitStore.fetch for more details.
   *
   * Note that this method will not perform the fetch of the specified remote
   * if _any_ fetches or pulls are currently in-progress.
   */
  public _fetch(repository: Repository, fetchType: FetchType): Promise<void> {
    return this.withAuthenticatingUser(repository, (repository, account) => {
      return this.performFetch(repository, account, fetchType)
    })
  }

  /**
   * Fetch a particular remote in a repository.
   *
   * Note that this method will not perform the fetch of the specified remote
   * if _any_ fetches or pulls are currently in-progress.
   */
  private _fetchRemote(
    repository: Repository,
    remote: IRemote,
    fetchType: FetchType
  ): Promise<void> {
    return this.withAuthenticatingUser(repository, (repository, account) => {
      return this.performFetch(repository, account, fetchType, [remote])
    })
  }

  /**
   * Fetch all relevant remotes or one or more given remotes in the repository.
   *
   * @param remotes Optional, one or more remotes to fetch if undefined all
   *                relevant remotes will be fetched. See gitStore.fetch for
   *                more detail on what constitutes a relevant remote.
   */
  private async performFetch(
    repository: Repository,
    account: IGitAccount | null,
    fetchType: FetchType,
    remotes?: IRemote[]
  ): Promise<void> {
    await this.withPushPull(repository, async () => {
      const gitStore = this.getGitStore(repository)

      try {
        const fetchWeight = 0.9
        const refreshWeight = 0.1
        const isBackgroundTask = fetchType === FetchType.BackgroundTask

        const progressCallback = (progress: IFetchProgress) => {
          this.updatePushPullFetchProgress(repository, {
            ...progress,
            value: progress.value * fetchWeight,
          })
        }

        if (remotes === undefined) {
          await gitStore.fetch(account, isBackgroundTask, progressCallback)
        } else {
          await gitStore.fetchRemotes(
            account,
            remotes,
            isBackgroundTask,
            progressCallback
          )
        }

        const refreshTitle = __DARWIN__
          ? 'Refreshing Repository'
          : 'Refreshing repository'

        this.updatePushPullFetchProgress(repository, {
          kind: 'generic',
          title: refreshTitle,
          value: fetchWeight,
        })

        await this._refreshRepository(repository)

        this.updatePushPullFetchProgress(repository, {
          kind: 'generic',
          title: refreshTitle,
          description: 'Fast-forwarding branches',
          value: fetchWeight + refreshWeight * 0.5,
        })

        await this.fastForwardBranches(repository)
      } finally {
        this.updatePushPullFetchProgress(repository, null)

        if (fetchType === FetchType.UserInitiatedTask) {
          this._refreshPullRequests(repository)
          if (repository.gitHubRepository != null) {
            this._refreshIssues(repository.gitHubRepository)
          }
        }
      }
    })
  }

  public _endWelcomeFlow(): Promise<void> {
    this.showWelcomeFlow = false

    this.emitUpdate()

    markWelcomeFlowComplete()

    return Promise.resolve()
  }

  public _setSidebarWidth(width: number): Promise<void> {
    this.sidebarWidth = width
    localStorage.setItem(sidebarWidthConfigKey, width.toString())
    this.emitUpdate()

    return Promise.resolve()
  }

  public _resetSidebarWidth(): Promise<void> {
    this.sidebarWidth = defaultSidebarWidth
    localStorage.removeItem(sidebarWidthConfigKey)
    this.emitUpdate()

    return Promise.resolve()
  }

  public _setCommitSummaryWidth(width: number): Promise<void> {
    this.commitSummaryWidth = width
    localStorage.setItem(commitSummaryWidthConfigKey, width.toString())
    this.emitUpdate()

    return Promise.resolve()
  }

  public _resetCommitSummaryWidth(): Promise<void> {
    this.commitSummaryWidth = defaultCommitSummaryWidth
    localStorage.removeItem(commitSummaryWidthConfigKey)
    this.emitUpdate()

    return Promise.resolve()
  }

  public _setCommitMessage(
    repository: Repository,
    message: ICommitMessage | null
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    return gitStore.setCommitMessage(message)
  }

  /**
   * Set the global application menu.
   *
   * This is called in response to the main process emitting an event signalling
   * that the application menu has changed in some way like an item being
   * added/removed or an item having its visibility toggled.
   *
   * This method should not be called by the renderer in any other circumstance
   * than as a directly result of the main-process event.
   *
   */
  private setAppMenu(menu: IMenu): Promise<void> {
    if (this.appMenu) {
      this.appMenu = this.appMenu.withMenu(menu)
    } else {
      this.appMenu = AppMenu.fromMenu(menu)
    }

    this.emitUpdate()
    return Promise.resolve()
  }

  public _setAppMenuState(
    update: (appMenu: AppMenu) => AppMenu
  ): Promise<void> {
    if (this.appMenu) {
      this.appMenu = update(this.appMenu)
      this.emitUpdate()
    }
    return Promise.resolve()
  }

  public _setAccessKeyHighlightState(highlight: boolean): Promise<void> {
    if (this.highlightAccessKeys !== highlight) {
      this.highlightAccessKeys = highlight
      this.emitUpdate()
    }

    return Promise.resolve()
  }

  public async _mergeBranch(
    repository: Repository,
    branch: string
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    await gitStore.merge(branch)

    return this._refreshRepository(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _setRemoteURL(
    repository: Repository,
    name: string,
    url: string
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    return gitStore.setRemoteURL(name, url)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _openShell(path: string) {
    this.statsStore.recordOpenShell()

    try {
      const match = await findShellOrDefault(this.selectedShell)
      await launchShell(match, path, error => this._pushError(error))
    } catch (error) {
      this.emitError(error)
    }
  }

  /** Takes a URL and opens it using the system default application */
  public _openInBrowser(url: string): Promise<boolean> {
    return shell.openExternal(url)
  }

  /** Open a path to a repository or file using the user's configured editor */
  public async _openInExternalEditor(fullPath: string): Promise<void> {
    const selectedExternalEditor =
      this.getState().selectedExternalEditor || null

    try {
      const match = await findEditorOrDefault(selectedExternalEditor)
      await launchExternalEditor(fullPath, match)
    } catch (error) {
      this.emitError(error)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _saveGitIgnore(
    repository: Repository,
    text: string
  ): Promise<void> {
    const repositorySettingsStore = this.getRepositorySettingsStore(repository)
    return repositorySettingsStore.saveGitIgnore(text)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _readGitIgnore(repository: Repository): Promise<string | null> {
    const repositorySettingsStore = this.getRepositorySettingsStore(repository)
    return repositorySettingsStore.readGitIgnore()
  }

  /** Has the user opted out of stats reporting? */
  public getStatsOptOut(): boolean {
    return this.statsStore.getOptOut()
  }

  /** Set whether the user has opted out of stats reporting. */
  public async setStatsOptOut(optOut: boolean): Promise<void> {
    await this.statsStore.setOptOut(optOut)

    this.emitUpdate()
  }

  public _setConfirmRepositoryRemovalSetting(
    confirmRepoRemoval: boolean
  ): Promise<void> {
    this.confirmRepoRemoval = confirmRepoRemoval
    localStorage.setItem(confirmRepoRemovalKey, confirmRepoRemoval ? '1' : '0')
    this.emitUpdate()

    return Promise.resolve()
  }

  public _setConfirmDiscardChangesSetting(value: boolean): Promise<void> {
    this.confirmDiscardChanges = value

    localStorage.setItem(confirmDiscardChangesKey, value ? '1' : '0')
    this.emitUpdate()

    return Promise.resolve()
  }

  public _setExternalEditor(selectedEditor: ExternalEditor): Promise<void> {
    this.selectedExternalEditor = selectedEditor
    localStorage.setItem(externalEditorKey, selectedEditor)
    this.emitUpdate()

    this.updateMenuItemLabels()

    return Promise.resolve()
  }

  public _setShell(shell: Shell): Promise<void> {
    this.selectedShell = shell
    localStorage.setItem(shellKey, shell)
    this.emitUpdate()

    this.updateMenuItemLabels()

    return Promise.resolve()
  }

  public _changeImageDiffType(type: ImageDiffType): Promise<void> {
    this.imageDiffType = type
    localStorage.setItem(imageDiffTypeKey, JSON.stringify(this.imageDiffType))
    this.emitUpdate()

    return Promise.resolve()
  }

  public _setUpdateBannerVisibility(visibility: boolean) {
    this.isUpdateAvailableBannerVisible = visibility

    this.emitUpdate()
  }

  public _reportStats() {
    return this.statsStore.reportStats(this.accounts, this.repositories)
  }

  public _recordLaunchStats(stats: ILaunchStats): Promise<void> {
    return this.statsStore.recordLaunchStats(stats)
  }

  public async _ignore(
    repository: Repository,
    pattern: string | string[]
  ): Promise<void> {
    const repoSettingsStore = this.getRepositorySettingsStore(repository)

    await repoSettingsStore.ignore(pattern)

    return this._refreshRepository(repository)
  }

  public _resetSignInState(): Promise<void> {
    this.signInStore.reset()
    return Promise.resolve()
  }

  public _beginDotComSignIn(): Promise<void> {
    this.signInStore.beginDotComSignIn()
    return Promise.resolve()
  }

  public _beginEnterpriseSignIn(): Promise<void> {
    this.signInStore.beginEnterpriseSignIn()
    return Promise.resolve()
  }

  public _setSignInEndpoint(url: string): Promise<void> {
    return this.signInStore.setEndpoint(url)
  }

  public _setSignInCredentials(
    username: string,
    password: string
  ): Promise<void> {
    return this.signInStore.authenticateWithBasicAuth(username, password)
  }

  public _requestBrowserAuthentication(): Promise<void> {
    return this.signInStore.authenticateWithBrowser()
  }

  public _setSignInOTP(otp: string): Promise<void> {
    return this.signInStore.setTwoFactorOTP(otp)
  }

  public async _setAppFocusState(isFocused: boolean): Promise<void> {
    if (this.appIsFocused !== isFocused) {
      this.appIsFocused = isFocused
      this.emitUpdate()
    }
  }

  /**
   * Start an Open in Desktop flow. This will return a new promise which will
   * resolve when `_completeOpenInDesktop` is called.
   */
  public _startOpenInDesktop(fn: () => void): Promise<Repository | null> {
    // tslint:disable-next-line:promise-must-complete
    const p = new Promise<Repository | null>(
      resolve => (this.resolveOpenInDesktop = resolve)
    )
    fn()
    return p
  }

  /**
   * Complete any active Open in Desktop flow with the repository returned by
   * the given function.
   */
  public async _completeOpenInDesktop(
    fn: () => Promise<Repository | null>
  ): Promise<Repository | null> {
    const resolve = this.resolveOpenInDesktop
    this.resolveOpenInDesktop = null

    const result = await fn()
    if (resolve) {
      resolve(result)
    }

    return result
  }

  public _updateRepositoryPath(
    repository: Repository,
    path: string
  ): Promise<Repository> {
    return this.repositoriesStore.updateRepositoryPath(repository, path)
  }

  public _removeAccount(account: Account): Promise<void> {
    log.info(
      `[AppStore] removing account ${account.login} (${
        account.name
      }) from store`
    )
    return this.accountsStore.removeAccount(account)
  }

  public async _addAccount(account: Account): Promise<void> {
    log.info(
      `[AppStore] adding account ${account.login} (${account.name}) to store`
    )
    await this.accountsStore.addAccount(account)
    const selectedState = this.getState().selectedState

    if (selectedState && selectedState.type === SelectionType.Repository) {
      // ensuring we have the latest set of accounts here, rather than waiting
      // and doing stuff when the account store emits an update and we refresh
      // the accounts field
      const accounts = await this.accountsStore.getAll()
      const repoState = selectedState.state
      const commits = repoState.commitLookup.values()
      this.loadAndCacheUsers(selectedState.repository, accounts, commits)
    }
  }

  private loadAndCacheUsers(
    repository: Repository,
    accounts: ReadonlyArray<Account>,
    commits: Iterable<Commit>
  ) {
    for (const commit of commits) {
      this.gitHubUserStore._loadAndCacheUser(
        accounts,
        repository,
        commit.sha,
        commit.author.email
      )
    }
  }

  public _updateRepositoryMissing(
    repository: Repository,
    missing: boolean
  ): Promise<Repository> {
    return this.repositoriesStore.updateRepositoryMissing(repository, missing)
  }

  public async _addRepositories(
    paths: ReadonlyArray<string>
  ): Promise<ReadonlyArray<Repository>> {
    const addedRepositories = new Array<Repository>()
    const lfsRepositories = new Array<Repository>()
    for (const path of paths) {
      const validatedPath = await validatedRepositoryPath(path)
      if (validatedPath) {
        log.info(`[AppStore] adding repository at ${validatedPath} to store`)

        const addedRepo = await this.repositoriesStore.addRepository(
          validatedPath
        )
        const [refreshedRepo, usingLFS] = await Promise.all([
          this._repositoryWithRefreshedGitHubRepository(addedRepo),
          this.isUsingLFS(addedRepo),
        ])
        addedRepositories.push(refreshedRepo)

        if (usingLFS) {
          lfsRepositories.push(refreshedRepo)
        }
      } else {
        const error = new Error(`${path} isn't a git repository.`)
        this.emitError(error)
      }
    }

    if (lfsRepositories.length > 0) {
      this._showPopup({
        type: PopupType.InitializeLFS,
        repositories: lfsRepositories,
      })
    }

    return addedRepositories
  }

  public async _removeRepositories(
    repositories: ReadonlyArray<Repository | CloningRepository>
  ): Promise<void> {
    const localRepositories = repositories.filter(
      r => r instanceof Repository
    ) as ReadonlyArray<Repository>
    const cloningRepositories = repositories.filter(
      r => r instanceof CloningRepository
    ) as ReadonlyArray<CloningRepository>
    cloningRepositories.forEach(r => {
      this._removeCloningRepository(r)
    })

    const repositoryIDs = localRepositories.map(r => r.id)
    for (const id of repositoryIDs) {
      await this.repositoriesStore.removeRepository(id)
    }

    const allRepositories = await this.repositoriesStore.getAll()
    if (allRepositories.length === 0) {
      this._closeFoldout(FoldoutType.Repository)
    } else {
      this._showFoldout({ type: FoldoutType.Repository })
    }
  }

  public async _cloneAgain(url: string, path: string): Promise<void> {
    const { promise, repository } = this._clone(url, path)
    await this._selectRepository(repository)
    const success = await promise
    if (!success) {
      return
    }

    const repositories = this.repositories
    const found = repositories.find(r => r.path === path)

    if (found) {
      const updatedRepository = await this._updateRepositoryMissing(
        found,
        false
      )
      await this._selectRepository(updatedRepository)
    }
  }

  private async withAuthenticatingUser<T>(
    repository: Repository,
    fn: (repository: Repository, account: IGitAccount | null) => Promise<T>
  ): Promise<T> {
    let updatedRepository = repository
    let account: IGitAccount | null = getAccountForRepository(
      this.accounts,
      updatedRepository
    )

    // If we don't have a user association, it might be because we haven't yet
    // tried to associate the repository with a GitHub repository, or that
    // association is out of date. So try again before we bail on providing an
    // authenticating user.
    if (!account) {
      updatedRepository = await this._repositoryWithRefreshedGitHubRepository(
        repository
      )
      account = getAccountForRepository(this.accounts, updatedRepository)
    }

    if (!account) {
      const gitStore = this.getGitStore(repository)
      const remote = gitStore.remote
      if (remote) {
        const hostname = getGenericHostname(remote.url)
        const username = getGenericUsername(hostname)
        if (username != null) {
          account = { login: username, endpoint: hostname }
        }
      }
    }

    if (account instanceof Account) {
      const hasValidToken =
        account.token.length > 0 ? 'has token' : 'empty token'
      log.info(
        `[AppStore.withAuthenticatingUser] account found for repository: ${
          repository.name
        } - ${account.login} (${hasValidToken})`
      )
    }

    return fn(updatedRepository, account)
  }

  private updateRevertProgress(
    repository: Repository,
    progress: IRevertProgress | null
  ) {
    this.updateRepositoryState(repository, state => ({
      revertProgress: progress,
    }))

    if (this.selectedRepository === repository) {
      this.emitUpdate()
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _revertCommit(
    repository: Repository,
    commit: Commit
  ): Promise<void> {
    return this.withAuthenticatingUser(repository, async (repo, account) => {
      const gitStore = this.getGitStore(repo)

      await gitStore.revertCommit(repo, commit, account, progress => {
        this.updateRevertProgress(repo, progress)
      })

      this.updateRevertProgress(repo, null)

      return gitStore.loadHistory()
    })
  }

  public async promptForGenericGitAuthentication(
    repository: Repository | CloningRepository,
    retryAction: RetryAction
  ): Promise<void> {
    let url
    if (repository instanceof Repository) {
      const gitStore = this.getGitStore(repository)
      const remote = gitStore.remote
      if (!remote) {
        return
      }

      url = remote.url
    } else {
      url = repository.url
    }

    const hostname = getGenericHostname(url)
    return this._showPopup({
      type: PopupType.GenericGitAuthentication,
      hostname,
      retryAction,
    })
  }

  public async _installGlobalLFSFilters(force: boolean): Promise<void> {
    try {
      await installGlobalLFSFilters(force)
    } catch (error) {
      this.emitError(error)
    }
  }

  private async isUsingLFS(repository: Repository): Promise<boolean> {
    try {
      return await isUsingLFS(repository)
    } catch (error) {
      return false
    }
  }

  public async _installLFSHooks(
    repositories: ReadonlyArray<Repository>
  ): Promise<void> {
    for (const repo of repositories) {
      try {
        // At this point we've asked the user if we should install them, so
        // force installation.
        await installLFSHooks(repo, true)
      } catch (error) {
        this.emitError(error)
      }
    }
  }

  public _changeCloneRepositoriesTab(tab: CloneRepositoryTab): Promise<void> {
    this.selectedCloneRepositoryTab = tab

    this.emitUpdate()

    return Promise.resolve()
  }

  public _openMergeTool(repository: Repository, path: string): Promise<void> {
    const gitStore = this.getGitStore(repository)
    return gitStore.openMergeTool(path)
  }

  public _changeBranchesTab(tab: BranchesTab): Promise<void> {
    this.selectedBranchesTab = tab

    this.emitUpdate()

    return Promise.resolve()
  }
  public _changeItemsTab(tab: ItemsTab): Promise<void> {
    this.selectedItemsTab = tab

    this.emitUpdate()

    return Promise.resolve()
  }
  public async _createPullRequest(repository: Repository): Promise<void> {
    const gitHubRepository = repository.gitHubRepository
    if (!gitHubRepository) {
      return
    }

    const state = this.getRepositoryState(repository)
    const tip = state.branchesState.tip

    if (tip.kind !== TipState.Valid) {
      return
    }

    const branch = tip.branch
    const aheadBehind = state.aheadBehind

    if (aheadBehind == null) {
      this._showPopup({
        type: PopupType.PushBranchCommits,
        repository,
        branch,
      })
    } else if (aheadBehind.ahead > 0) {
      this._showPopup({
        type: PopupType.PushBranchCommits,
        repository,
        branch,
        unPushedCommits: aheadBehind.ahead,
      })
    } else {
      await this._openCreatePullRequestInBrowser(repository, branch)
    }
  }

  public async _showPullRequest(repository: Repository): Promise<void> {
    const gitHubRepository = repository.gitHubRepository

    if (!gitHubRepository) {
      return
    }

    const state = this.getRepositoryState(repository)
    const currentPullRequest = state.branchesState.currentPullRequest

    if (!currentPullRequest) {
      return
    }

    const baseURL = `${gitHubRepository.htmlURL}/pull/${
      currentPullRequest.number
    }`

    await this._openInBrowser(baseURL)
  }

  private async loadPullRequests(
    repository: Repository,
    loader: (account: Account) => void
  ) {
    const gitHubRepository = repository.gitHubRepository

    if (gitHubRepository == null) {
      return
    }

    const account = getAccountForEndpoint(
      this.accounts,
      gitHubRepository.endpoint
    )

    if (account == null) {
      return
    }

    await loader(account)
  }

  public async _refreshPullRequests(repository: Repository): Promise<void> {
    return this.loadPullRequests(repository, async account => {
      await this.pullRequestStore.fetchAndCachePullRequests(repository, account)
      this.updateMenuItemLabels(repository)
    })
  }

  private async onPullRequestStoreUpdated(gitHubRepository: GitHubRepository) {
    const promiseForPRs = this.pullRequestStore.fetchPullRequestsFromCache(
      gitHubRepository
    )
    const isLoading = this.pullRequestStore.isFetchingPullRequests(
      gitHubRepository
    )

    const repository = this.repositories.find(
      r =>
        !!r.gitHubRepository &&
        r.gitHubRepository.dbID === gitHubRepository.dbID
    )
    if (!repository) {
      return
    }

    const prs = await promiseForPRs
    this.updateBranchesState(repository, state => {
      return {
        openPullRequests: prs,
        isLoadingPullRequests: isLoading,
      }
    })

    this._updateCurrentPullRequest(repository)
    this.emitUpdate()
  }

  private findAssociatedPullRequest(
    branch: Branch,
    pullRequests: ReadonlyArray<PullRequest>,
    gitHubRepository: GitHubRepository,
    remote: IRemote
  ): PullRequest | null {
    const upstream = branch.upstreamWithoutRemote

    if (upstream == null) {
      return null
    }

    const pr =
      pullRequests.find(
        pr =>
          pr.head.ref === upstream &&
          pr.head.gitHubRepository != null &&
          repositoryMatchesRemote(pr.head.gitHubRepository, remote)
      ) || null

    return pr
  }

  private _updateCurrentPullRequest(repository: Repository) {
    const gitHubRepository = repository.gitHubRepository

    if (!gitHubRepository) {
      return
    }

    this.updateBranchesState(repository, state => {
      let currentPullRequest: PullRequest | null = null

      const remote = this.getRepositoryState(repository).remote

      if (state.tip.kind === TipState.Valid && remote) {
        currentPullRequest = this.findAssociatedPullRequest(
          state.tip.branch,
          state.openPullRequests,
          gitHubRepository,
          remote
        )
      }

      return {
        currentPullRequest,
      }
    })

    this.emitUpdate()
  }

  public async _openCreatePullRequestInBrowser(
    repository: Repository,
    branch: Branch
  ): Promise<void> {
    const gitHubRepository = repository.gitHubRepository
    if (!gitHubRepository) {
      return
    }

    const urlEncodedBranchName = QueryString.escape(branch.nameWithoutRemote)
    const baseURL = `${
      gitHubRepository.htmlURL
    }/pull/new/${urlEncodedBranchName}`

    await this._openInBrowser(baseURL)
  }

  public async _updateExistingUpstreamRemote(
    repository: Repository
  ): Promise<void> {
    const gitStore = this.getGitStore(repository)
    await gitStore.updateExistingUpstreamRemote()

    return this._refreshRepository(repository)
  }

  private getIgnoreExistingUpstreamRemoteKey(repository: Repository): string {
    return `repository/${repository.id}/ignoreExistingUpstreamRemote`
  }

  public _ignoreExistingUpstreamRemote(repository: Repository): Promise<void> {
    const key = this.getIgnoreExistingUpstreamRemoteKey(repository)
    localStorage.setItem(key, '1')

    return Promise.resolve()
  }

  private getIgnoreExistingUpstreamRemote(
    repository: Repository
  ): Promise<boolean> {
    const key = this.getIgnoreExistingUpstreamRemoteKey(repository)
    const value = localStorage.getItem(key)
    return Promise.resolve(value === '1')
  }

  private async addUpstreamRemoteIfNeeded(repository: Repository) {
    const gitStore = this.getGitStore(repository)
    const ignored = await this.getIgnoreExistingUpstreamRemote(repository)
    if (ignored) {
      return
    }

    return gitStore.addUpstreamRemoteIfNeeded()
  }

  public async _checkoutPullRequest(
    repository: Repository,
    pullRequest: PullRequest
  ): Promise<void> {
    const gitHubRepository = forceUnwrap(
      `Cannot checkout a PR if the repository doesn't have a GitHub repository`,
      repository.gitHubRepository
    )
    const head = pullRequest.head
    const isRefInThisRepo =
      head.gitHubRepository &&
      head.gitHubRepository.cloneURL === gitHubRepository.cloneURL

    if (isRefInThisRepo) {
      const defaultRemote = await getDefaultRemote(repository)
      // if we don't have a default remote here, it's probably going
      // to just crash and burn on checkout, but that's okay
      if (defaultRemote != null) {
        // the remote ref will be something like `origin/my-cool-branch`
        const remoteRef = `${defaultRemote.name}/${head.ref}`
        const gitStore = this.getGitStore(repository)

        const remoteRefExists =
          gitStore.allBranches.find(branch => branch.name === remoteRef) != null

        // only try a fetch here if we can't find the ref
        if (!remoteRefExists) {
          await this._fetchRemote(
            repository,
            defaultRemote,
            FetchType.UserInitiatedTask
          )
        }
      }
      await this._checkoutBranch(repository, head.ref)
    } else if (head.gitHubRepository != null) {
      const cloneURL = forceUnwrap(
        "This pull request's clone URL is not populated but should be",
        head.gitHubRepository.cloneURL
      )
      const remoteName = forkPullRequestRemoteName(
        head.gitHubRepository.owner.login
      )
      const remotes = await getRemotes(repository)
      const remote =
        remotes.find(r => r.name === remoteName) ||
        (await addRemote(repository, remoteName, cloneURL))

      if (remote.url !== cloneURL) {
        const error = new Error(
          `Expected PR remote ${remoteName} url to be ${cloneURL} got ${
            remote.url
          }.`
        )

        log.error(error.message)
        return this.emitError(error)
      }

      await this._fetchRemote(repository, remote, FetchType.UserInitiatedTask)

      const gitStore = this.getGitStore(repository)

      const localBranchName = `pr/${pullRequest.number}`
      const doesBranchExist =
        gitStore.allBranches.find(branch => branch.name === localBranchName) !=
        null

      if (!doesBranchExist) {
        await this._createBranch(
          repository,
          localBranchName,
          `${remoteName}/${head.ref}`
        )
      }

      await this._checkoutBranch(repository, localBranchName)
    }

    this.statsStore.recordPRBranchCheckout()
  }

  /**
   * Set whether the user has chosen to hide or show the
   * co-authors field in the commit message component
   */
  public _setShowCoAuthoredBy(
    repository: Repository,
    showCoAuthoredBy: boolean
  ) {
    this.getGitStore(repository).setShowCoAuthoredBy(showCoAuthoredBy)
    return Promise.resolve()
  }

  /**
   * Update the per-repository co-authors list
   *
   * @param repository Co-author settings are per-repository
   * @param coAuthors  Zero or more authors
   */
  public _setCoAuthors(
    repository: Repository,
    coAuthors: ReadonlyArray<IAuthor>
  ) {
    this.getGitStore(repository).setCoAuthors(coAuthors)
    return Promise.resolve()
  }

  /**
   * Increments the `mergeIntoCurrentBranchMenuCount` metric
   */
  public _recordMenuInitiatedMerge() {
    this.statsStore.recordMenuInitiatedMerge()
  }

  /**
   * Increments the `updateFromDefaultBranchMenuCount` metric
   */
  public _recordMenuInitiatedUpdate() {
    this.statsStore.recordMenuInitiatedUpdate()
  }

  /**
   * Increments the `mergesInitiatedFromComparison` metric
   */
  public _recordCompareInitiatedMerge() {
    this.statsStore.recordCompareInitiatedMerge()
  }
}

function forkPullRequestRemoteName(remoteName: string) {
  return `${ForkedRemotePrefix}${remoteName}`
}

/**
 * Map the cached state of the compare view to an action
 * to perform which is then used to compute the compare
 * view contents.
 */
function getInitialAction(
  cachedState: IDisplayHistory | ICompareBranch
): CompareAction {
  if (cachedState.kind === ComparisonView.None) {
    return {
      kind: CompareActionKind.History,
    }
  }

  return {
    kind: CompareActionKind.Branch,
    branch: cachedState.comparisonBranch,
    mode: cachedState.kind,
  }
}
