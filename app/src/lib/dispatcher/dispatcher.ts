import * as Path from 'path'

import { remote } from 'electron'
import { Disposable } from 'event-kit'

import { Account } from '../../models/account'
import { Repository } from '../../models/repository'
import {
  WorkingDirectoryFileChange,
  CommittedFileChange,
} from '../../models/status'
import { DiffSelection } from '../../models/diff'
import {
  RepositorySectionTab,
  Popup,
  PopupType,
  Foldout,
  FoldoutType,
  ImageDiffType,
  CompareAction,
  ICompareFormUpdate,
} from '../app-state'
import { AppStore } from '../stores/app-store'
import { CloningRepository } from '../../models/cloning-repository'
import { Branch } from '../../models/branch'
import { Commit } from '../../models/commit'
import { ExternalEditor } from '../editors'
import { IAPIUser } from '../api'
import { GitHubRepository } from '../../models/github-repository'
import { ICommitMessage } from '../stores/git-store'
import { executeMenuItem } from '../../ui/main-process-proxy'
import { AppMenu, ExecutableMenuItem } from '../../models/app-menu'
import { matchExistingRepository } from '../repository-matching'
import { ILaunchStats } from '../stats'
import { fatalError, assertNever } from '../fatal-error'
import { isGitOnPath } from '../is-git-on-path'
import { shell } from '../app-shell'
import {
  URLActionType,
  IOpenRepositoryFromURLAction,
  IUnknownAction,
} from '../parse-app-url'
import {
  requestAuthenticatedUser,
  resolveOAuthRequest,
  rejectOAuthRequest,
} from '../oauth'
import { installCLI } from '../../ui/lib/install-cli'
import { setGenericUsername, setGenericPassword } from '../generic-git-auth'
import { RetryAction, RetryActionType } from '../retry-actions'
import { Shell } from '../shells'
import { CloneRepositoryTab } from '../../models/clone-repository-tab'
import { validatedRepositoryPath } from '../stores/helpers/validated-repository-path'
import { BranchesTab } from '../../models/branches-tab'
import { ItemsTab } from '../../models/items-tab'
import { FetchType } from '../stores'
import { PullRequest } from '../../models/pull-request'
import { IAuthor } from '../../models/author'
import { ITrailer } from '../git/interpret-trailers'
import { isGitRepository } from '../git'

/**
 * An error handler function.
 *
 * If the returned {Promise} returns an error, it will be passed to the next
 * error handler. If it returns null, error propagation is halted.
 */
export type ErrorHandler = (
  error: Error,
  dispatcher: Dispatcher
) => Promise<Error | null>

/**
 * The Dispatcher acts as the hub for state. The StateHub if you will. It
 * decouples the consumer of state from where/how it is stored.
 */
export class Dispatcher {
  private readonly appStore: AppStore

  private readonly errorHandlers = new Array<ErrorHandler>()

  public constructor(appStore: AppStore) {
    this.appStore = appStore
  }

  /** Load the initial state for the app. */
  public loadInitialState(): Promise<void> {
    return this.appStore.loadInitialState()
  }

  /**
   * Add the repositories at the given paths. If a path isn't a repository, then
   * this will post an error to that affect.
   */
  public addRepositories(
    paths: ReadonlyArray<string>
  ): Promise<ReadonlyArray<Repository>> {
    return this.appStore._addRepositories(paths)
  }

  /** Remove the repositories represented by the given IDs from local storage. */
  public removeRepositories(
    repositories: ReadonlyArray<Repository | CloningRepository>
  ): Promise<void> {
    return this.appStore._removeRepositories(repositories)
  }

  /** Update the repository's `missing` flag. */
  public async updateRepositoryMissing(
    repository: Repository,
    missing: boolean
  ): Promise<Repository> {
    return this.appStore._updateRepositoryMissing(repository, missing)
  }

  /** Load the history for the repository. */
  public loadHistory(repository: Repository): Promise<void> {
    return this.appStore._loadHistory(repository)
  }

  /** Load the next batch of history for the repository. */
  public loadNextHistoryBatch(repository: Repository): Promise<void> {
    return this.appStore._loadNextHistoryBatch(repository)
  }

  /** Load the changed files for the current history selection. */
  public loadChangedFilesForCurrentSelection(
    repository: Repository
  ): Promise<void> {
    return this.appStore._loadChangedFilesForCurrentSelection(repository)
  }

  /**
   * Change the selected commit in the history view.
   *
   * @param repository The currently active repository instance
   *
   * @param sha The object id of one of the commits currently
   *            the history list, represented as a SHA-1 hash
   *            digest. This should match exactly that of Commit.Sha
   */
  public changeHistoryCommitSelection(
    repository: Repository,
    sha: string
  ): Promise<void> {
    return this.appStore._changeHistoryCommitSelection(repository, sha)
  }

  /**
   * Change the selected changed file in the history view.
   *
   * @param repository The currently active repository instance
   *
   * @param file A FileChange instance among those available in
   *            IHistoryState.changedFiles
   */
  public changeHistoryFileSelection(
    repository: Repository,
    file: CommittedFileChange
  ): Promise<void> {
    return this.appStore._changeHistoryFileSelection(repository, file)
  }

  /** Set the repository filter text. */
  public setRepositoryFilterText(text: string): Promise<void> {
    return this.appStore._setRepositoryFilterText(text)
  }

  /** Select the repository. */
  public selectRepository(
    repository: Repository | CloningRepository
  ): Promise<Repository | null> {
    return this.appStore._selectRepository(repository)
  }

  /** Load the working directory status. */
  public loadStatus(repository: Repository): Promise<void> {
    return this.appStore._loadStatus(repository)
  }

  /** Change the selected section in the repository. */
  public changeRepositorySection(
    repository: Repository,
    section: RepositorySectionTab
  ): Promise<void> {
    return this.appStore._changeRepositorySection(repository, section)
  }

  /** Change the currently selected file in Changes. */
  public changeChangesSelection(
    repository: Repository,
    selectedFiles: WorkingDirectoryFileChange[]
  ): Promise<void> {
    return this.appStore._changeChangesSelection(repository, selectedFiles)
  }

  /**
   * Commit the changes which were marked for inclusion, using the given commit
   * summary and description and optionally any number of commit message trailers
   * which will be merged into the final commit message.
   */
  public async commitIncludedChanges(
    repository: Repository,
    summary: string,
    description: string | null,
    trailers?: ReadonlyArray<ITrailer>
  ): Promise<boolean> {
    return this.appStore._commitIncludedChanges(
      repository,
      summary,
      description,
      trailers
    )
  }

  /** Change the file's includedness. */
  public changeFileIncluded(
    repository: Repository,
    file: WorkingDirectoryFileChange,
    include: boolean
  ): Promise<void> {
    return this.appStore._changeFileIncluded(repository, file, include)
  }

  /** Change the file's line selection state. */
  public changeFileLineSelection(
    repository: Repository,
    file: WorkingDirectoryFileChange,
    diffSelection: DiffSelection
  ): Promise<void> {
    return this.appStore._changeFileLineSelection(
      repository,
      file,
      diffSelection
    )
  }

  /** Change the Include All state. */
  public changeIncludeAllFiles(
    repository: Repository,
    includeAll: boolean
  ): Promise<void> {
    return this.appStore._changeIncludeAllFiles(repository, includeAll)
  }

  /**
   * Refresh the repository. This would be used, e.g., when the app gains focus.
   */
  public refreshRepository(repository: Repository): Promise<void> {
    return this.appStore._refreshRepository(repository)
  }

  /** Show the popup. This will close any current popup. */
  public showPopup(popup: Popup): Promise<void> {
    return this.appStore._showPopup(popup)
  }

  /** Close the current popup. */
  public closePopup(): Promise<void> {
    return this.appStore._closePopup()
  }

  /** Show the foldout. This will close any current popup. */
  public showFoldout(foldout: Foldout): Promise<void> {
    return this.appStore._showFoldout(foldout)
  }

  /** Close the current foldout. If opening a new foldout use closeFoldout instead. */
  public closeCurrentFoldout(): Promise<void> {
    return this.appStore._closeCurrentFoldout()
  }

  /** Close the specified foldout. */
  public closeFoldout(foldout: FoldoutType): Promise<void> {
    return this.appStore._closeFoldout(foldout)
  }

  /**
   * Create a new branch from the given starting point and check it out.
   *
   * If the startPoint argument is omitted the new branch will be created based
   * off of the current state of HEAD.
   */
  public createBranch(
    repository: Repository,
    name: string,
    startPoint?: string
  ): Promise<Repository> {
    return this.appStore._createBranch(repository, name, startPoint)
  }

  /** Check out the given branch. */
  public checkoutBranch(
    repository: Repository,
    branch: Branch | string
  ): Promise<Repository> {
    return this.appStore._checkoutBranch(repository, branch)
  }

  /** Push the current branch. */
  public push(repository: Repository): Promise<void> {
    return this.appStore._push(repository)
  }

  /** Pull the current branch. */
  public pull(repository: Repository): Promise<void> {
    return this.appStore._pull(repository)
  }

  /** Fetch a specific refspec for the repository. */
  public fetchRefspec(
    repository: Repository,
    fetchspec: string
  ): Promise<void> {
    return this.appStore._fetchRefspec(repository, fetchspec)
  }

  /** Fetch all refs for the repository */
  public fetch(repository: Repository, fetchType: FetchType): Promise<void> {
    return this.appStore._fetch(repository, fetchType)
  }

  /** Publish the repository to GitHub with the given properties. */
  public publishRepository(
    repository: Repository,
    name: string,
    description: string,
    private_: boolean,
    account: Account,
    org: IAPIUser | null
  ): Promise<Repository> {
    return this.appStore._publishRepository(
      repository,
      name,
      description,
      private_,
      account,
      org
    )
  }

  /**
   * Post the given error. This will send the error through the standard error
   * handler machinery.
   */
  public async postError(error: Error): Promise<void> {
    let currentError: Error | null = error
    for (let i = this.errorHandlers.length - 1; i >= 0; i--) {
      const handler = this.errorHandlers[i]
      currentError = await handler(currentError, this)

      if (!currentError) {
        break
      }
    }

    if (currentError) {
      fatalError(
        `Unhandled error ${currentError}. This shouldn't happen! All errors should be handled, even if it's just by the default handler.`
      )
    }
  }

  /**
   * Post the given error. Note that this bypasses the standard error handler
   * machinery. You probably don't want that. See `Dispatcher.postError`
   * instead.
   */
  public presentError(error: Error): Promise<void> {
    return this.appStore._pushError(error)
  }

  /** Clear the given error. */
  public clearError(error: Error): Promise<void> {
    return this.appStore._clearError(error)
  }

  /**
   * Clone a missing repository to the previous path, and update it's
   * state in the repository list if the clone completes without error.
   */
  public cloneAgain(url: string, path: string): Promise<void> {
    return this.appStore._cloneAgain(url, path)
  }

  /** Clone the repository to the path. */
  public async clone(
    url: string,
    path: string,
    options?: { branch?: string }
  ): Promise<Repository | null> {
    return this.appStore._completeOpenInDesktop(async () => {
      const { promise, repository } = this.appStore._clone(url, path, options)
      await this.selectRepository(repository)
      const success = await promise
      // TODO: this exit condition is not great, bob
      if (!success) {
        return null
      }

      const addedRepositories = await this.addRepositories([path])
      const addedRepository = addedRepositories[0]
      await this.selectRepository(addedRepository)

      return addedRepository
    })
  }

  /** Rename the branch to a new name. */
  public renameBranch(
    repository: Repository,
    branch: Branch,
    newName: string
  ): Promise<void> {
    return this.appStore._renameBranch(repository, branch, newName)
  }

  /**
   * Delete the branch. This will delete both the local branch and the remote
   * branch, and then check out the default branch.
   */
  public deleteBranch(
    repository: Repository,
    branch: Branch,
    includeRemote: boolean
  ): Promise<void> {
    return this.appStore._deleteBranch(repository, branch, includeRemote)
  }

  /** Discard the changes to the given files. */
  public discardChanges(
    repository: Repository,
    files: ReadonlyArray<WorkingDirectoryFileChange>
  ): Promise<void> {
    return this.appStore._discardChanges(repository, files)
  }

  /** Undo the given commit. */
  public undoCommit(repository: Repository, commit: Commit): Promise<void> {
    return this.appStore._undoCommit(repository, commit)
  }

  /** Revert the commit with the given SHA */
  public revertCommit(repository: Repository, commit: Commit): Promise<void> {
    return this.appStore._revertCommit(repository, commit)
  }

  /**
   * Set the width of the repository sidebar to the given
   * value. This affects the changes and history sidebar
   * as well as the first toolbar section which contains
   * repo selection on all platforms and repo selection and
   * app menu on Windows.
   */
  public setSidebarWidth(width: number): Promise<void> {
    return this.appStore._setSidebarWidth(width)
  }

  /**
   * Set the update banner's visibility
   */
  public setUpdateBannerVisibility(isVisible: boolean) {
    return this.appStore._setUpdateBannerVisibility(isVisible)
  }

  /**
   * Reset the width of the repository sidebar to its default
   * value. This affects the changes and history sidebar
   * as well as the first toolbar section which contains
   * repo selection on all platforms and repo selection and
   * app menu on Windows.
   */
  public resetSidebarWidth(): Promise<void> {
    return this.appStore._resetSidebarWidth()
  }

  /**
   * Set the width of the commit summary column in the
   * history view to the given value.
   */
  public setCommitSummaryWidth(width: number): Promise<void> {
    return this.appStore._setCommitSummaryWidth(width)
  }

  /**
   * Reset the width of the commit summary column in the
   * history view to its default value.
   */
  public resetCommitSummaryWidth(): Promise<void> {
    return this.appStore._resetCommitSummaryWidth()
  }

  /** Update the repository's issues from GitHub. */
  public refreshIssues(repository: GitHubRepository): Promise<void> {
    return this.appStore._refreshIssues(repository)
  }

  /** End the Welcome flow. */
  public endWelcomeFlow(): Promise<void> {
    return this.appStore._endWelcomeFlow()
  }

  /**
   * Set the commit summary and description for a work-in-progress
   * commit in the changes view for a particular repository.
   */
  public setCommitMessage(
    repository: Repository,
    message: ICommitMessage | null
  ): Promise<void> {
    return this.appStore._setCommitMessage(repository, message)
  }

  /** Add the account to the app. */
  public addAccount(account: Account): Promise<void> {
    return this.appStore._addAccount(account)
  }

  /** Remove the given account from the app. */
  public removeAccount(account: Account): Promise<void> {
    return this.appStore._removeAccount(account)
  }

  /**
   * Ask the dispatcher to apply a transformation function to the current
   * state of the application menu.
   *
   * Since the dispatcher is asynchronous it's possible for components
   * utilizing the menu state to have an out-of-date view of the state
   * of the app menu which is why they're not allowed to transform it
   * directly.
   *
   * To work around potential race conditions consumers instead pass a
   * delegate which receives the updated application menu and allows
   * them to perform the necessary state transitions. The AppMenu instance
   * is itself immutable but does offer transformation methods and in
   * order for the state to be properly updated the delegate _must_ return
   * the latest transformed instance of the AppMenu.
   */
  public setAppMenuState(update: (appMenu: AppMenu) => AppMenu): Promise<void> {
    return this.appStore._setAppMenuState(update)
  }

  /**
   * Tell the main process to execute (i.e. simulate a click of) the given menu item.
   */
  public executeMenuItem(item: ExecutableMenuItem): Promise<void> {
    executeMenuItem(item)
    return Promise.resolve()
  }

  /**
   * Set whether or not to to add a highlight class to the app menu toolbar icon.
   * Used to highlight the button when the Alt key is pressed.
   *
   * Only applicable on non-macOS platforms.
   */
  public setAccessKeyHighlightState(highlight: boolean): Promise<void> {
    return this.appStore._setAccessKeyHighlightState(highlight)
  }

  /** Merge the named branch into the current branch. */
  public mergeBranch(repository: Repository, branch: string): Promise<void> {
    return this.appStore._mergeBranch(repository, branch)
  }

  /** Record the given launch stats. */
  public recordLaunchStats(stats: ILaunchStats): Promise<void> {
    return this.appStore._recordLaunchStats(stats)
  }

  /** Report any stats if needed. */
  public reportStats(): Promise<void> {
    return this.appStore._reportStats()
  }

  /** Changes the URL for the remote that matches the given name  */
  public setRemoteURL(
    repository: Repository,
    name: string,
    url: string
  ): Promise<void> {
    return this.appStore._setRemoteURL(repository, name, url)
  }

  /** Open the URL in a browser */
  public openInBrowser(url: string): Promise<boolean> {
    return this.appStore._openInBrowser(url)
  }

  /** Add the pattern to the repository's gitignore. */
  public ignore(
    repository: Repository,
    pattern: string | string[]
  ): Promise<void> {
    return this.appStore._ignore(repository, pattern)
  }

  /** Opens a Git-enabled terminal setting the working directory to the repository path */
  public async openShell(
    path: string,
    ignoreWarning: boolean = false
  ): Promise<void> {
    const gitFound = await isGitOnPath()
    if (gitFound || ignoreWarning) {
      this.appStore._openShell(path)
    } else {
      this.appStore._showPopup({ type: PopupType.InstallGit, path })
    }
  }

  /**
   * Opens a path in the external editor selected by the user.
   */
  public async openInExternalEditor(fullPath: string): Promise<void> {
    return this.appStore._openInExternalEditor(fullPath)
  }

  /**
   * Persist the given content to the repository's root .gitignore.
   *
   * If the repository root doesn't contain a .gitignore file one
   * will be created, otherwise the current file will be overwritten.
   */
  public async saveGitIgnore(
    repository: Repository,
    text: string
  ): Promise<void> {
    await this.appStore._saveGitIgnore(repository, text)
    await this.appStore._refreshRepository(repository)
  }

  /**
   * Read the contents of the repository's .gitignore.
   *
   * Returns a promise which will either be rejected or resolved
   * with the contents of the file. If there's no .gitignore file
   * in the repository root the promise will resolve with null.
   */
  public async readGitIgnore(repository: Repository): Promise<string | null> {
    return this.appStore._readGitIgnore(repository)
  }

  /** Set whether the user has opted out of stats reporting. */
  public setStatsOptOut(optOut: boolean): Promise<void> {
    return this.appStore.setStatsOptOut(optOut)
  }

  /**
   * Clear any in-flight sign in state and return to the
   * initial (no sign-in) state.
   */
  public resetSignInState(): Promise<void> {
    return this.appStore._resetSignInState()
  }

  /**
   * Initiate a sign in flow for github.com. This will put the store
   * in the Authentication step ready to receive user credentials.
   */
  public beginDotComSignIn(): Promise<void> {
    return this.appStore._beginDotComSignIn()
  }

  /**
   * Initiate a sign in flow for a GitHub Enterprise instance. This will
   * put the store in the EndpointEntry step ready to receive the url
   * to the enterprise instance.
   */
  public beginEnterpriseSignIn(): Promise<void> {
    return this.appStore._beginEnterpriseSignIn()
  }

  /**
   * Attempt to advance from the EndpointEntry step with the given endpoint
   * url. This method must only be called when the store is in the authentication
   * step or an error will be thrown.
   *
   * The provided endpoint url will be validated for syntactic correctness as
   * well as connectivity before the promise resolves. If the endpoint url is
   * invalid or the host can't be reached the promise will be rejected and the
   * sign in state updated with an error to be presented to the user.
   *
   * If validation is successful the store will advance to the authentication
   * step.
   */
  public setSignInEndpoint(url: string): Promise<void> {
    return this.appStore._setSignInEndpoint(url)
  }

  /**
   * Attempt to advance from the authentication step using a username
   * and password. This method must only be called when the store is
   * in the authentication step or an error will be thrown. If the
   * provided credentials are valid the store will either advance to
   * the Success step or to the TwoFactorAuthentication step if the
   * user has enabled two factor authentication.
   *
   * If an error occurs during sign in (such as invalid credentials)
   * the authentication state will be updated with that error so that
   * the responsible component can present it to the user.
   */
  public setSignInCredentials(
    username: string,
    password: string
  ): Promise<void> {
    return this.appStore._setSignInCredentials(username, password)
  }

  /**
   * Initiate an OAuth sign in using the system configured browser.
   * This method must only be called when the store is in the authentication
   * step or an error will be thrown.
   *
   * The promise returned will only resolve once the user has successfully
   * authenticated. If the user terminates the sign-in process by closing
   * their browser before the protocol handler is invoked, by denying the
   * protocol handler to execute or by providing the wrong credentials
   * this promise will never complete.
   */
  public requestBrowserAuthentication(): Promise<void> {
    return this.appStore._requestBrowserAuthentication()
  }

  /**
   * Attempt to complete the sign in flow with the given OTP token.\
   * This method must only be called when the store is in the
   * TwoFactorAuthentication step or an error will be thrown.
   *
   * If the provided token is valid the store will advance to
   * the Success step.
   *
   * If an error occurs during sign in (such as invalid credentials)
   * the authentication state will be updated with that error so that
   * the responsible component can present it to the user.
   */
  public setSignInOTP(otp: string): Promise<void> {
    return this.appStore._setSignInOTP(otp)
  }

  /**
   * Launch a sign in dialog for authenticating a user with
   * GitHub.com.
   */
  public async showDotComSignInDialog(): Promise<void> {
    await this.appStore._beginDotComSignIn()
    await this.appStore._showPopup({ type: PopupType.SignIn })
  }

  /**
   * Launch a sign in dialog for authenticating a user with
   * a GitHub Enterprise instance.
   */
  public async showEnterpriseSignInDialog(): Promise<void> {
    await this.appStore._beginEnterpriseSignIn()
    await this.appStore._showPopup({ type: PopupType.SignIn })
  }

  /**
   * Register a new error handler.
   *
   * Error handlers are called in order starting with the most recently
   * registered handler. The error which the returned {Promise} resolves to is
   * passed to the next handler, etc. If the handler's {Promise} resolves to
   * null, error propagation is halted.
   */
  public registerErrorHandler(handler: ErrorHandler): Disposable {
    this.errorHandlers.push(handler)

    return new Disposable(() => {
      const i = this.errorHandlers.indexOf(handler)
      if (i >= 0) {
        this.errorHandlers.splice(i, 1)
      }
    })
  }

  /**
   * Update the location of an existing repository and clear the missing flag.
   */
  public async relocateRepository(repository: Repository): Promise<void> {
    const directories = remote.dialog.showOpenDialog({
      properties: ['openDirectory'],
    })

    if (directories && directories.length > 0) {
      const newPath = directories[0]
      await this.updateRepositoryPath(repository, newPath)
    }
  }

  /** Update the repository's path. */
  private async updateRepositoryPath(
    repository: Repository,
    path: string
  ): Promise<void> {
    await this.appStore._updateRepositoryPath(repository, path)
  }

  public async setAppFocusState(isFocused: boolean): Promise<void> {
    await this.appStore._setAppFocusState(isFocused)
  }

  public async dispatchURLAction(action: URLActionType): Promise<void> {
    switch (action.name) {
      case 'oauth':
        try {
          log.info(`[Dispatcher] requesting authenticated user`)
          const user = await requestAuthenticatedUser(action.code)
          if (user) {
            resolveOAuthRequest(user)
          } else {
            rejectOAuthRequest(new Error('Unable to fetch authenticated user.'))
          }
        } catch (e) {
          rejectOAuthRequest(e)
        }

        if (__DARWIN__) {
          // workaround for user reports that the application doesn't receive focus
          // after completing the OAuth signin in the browser
          const window = remote.getCurrentWindow()
          if (!window.isFocused()) {
            log.info(
              `refocusing the main window after the OAuth flow is completed`
            )
            window.focus()
          }
        }
        break

      case 'open-repository-from-url':
        const { pr, url, branch } = action
        // a forked PR will provide both these values, despite the branch not existing
        // in the repository - drop the branch argument in this case so a clone will
        // checkout the default branch when it clones
        const branchToClone = pr && branch ? null : branch || null
        const repository = await this.openRepository(url, branchToClone)
        if (repository) {
          this.handleCloneInDesktopOptions(repository, action)
        } else {
          log.warn(
            `Open Repository from URL failed, did not find repository: ${url} - payload: ${JSON.stringify(
              action
            )}`
          )
        }
        break

      case 'open-repository-from-path':
        // user may accidentally provide a folder within the repository
        // this ensures we use the repository root, if it is actually a repository
        // otherwise we consider it an untracked repository
        const path = (await validatedRepositoryPath(action.path)) || action.path
        const state = this.appStore.getState()
        let existingRepository = matchExistingRepository(
          state.repositories,
          path
        )

        // in case this is valid git repository, there is no need to ask
        // user for confirmation and it can be added automatically
        if (existingRepository == null) {
          const isRepository = await isGitRepository(path)
          if (isRepository) {
            const addedRepositories = await this.addRepositories([path])
            existingRepository = addedRepositories[0]
          }
        }

        if (existingRepository) {
          await this.selectRepository(existingRepository)
        } else {
          await this.showPopup({
            type: PopupType.AddRepository,
            path,
          })
        }
        break

      default:
        const unknownAction: IUnknownAction = action
        log.warn(
          `Unknown URL action: ${
            unknownAction.name
          } - payload: ${JSON.stringify(unknownAction)}`
        )
    }
  }

  /**
   * Sets the user's preference so that confirmation to remove repo is not asked
   */
  public setConfirmRepoRemovalSetting(value: boolean): Promise<void> {
    return this.appStore._setConfirmRepositoryRemovalSetting(value)
  }

  /**
   * Sets the user's preference so that confirmation to discard changes is not asked
   */
  public setConfirmDiscardChangesSetting(value: boolean): Promise<void> {
    return this.appStore._setConfirmDiscardChangesSetting(value)
  }

  /**
   * Sets the user's preference for an external program to open repositories in.
   */
  public setExternalEditor(editor: ExternalEditor): Promise<void> {
    return this.appStore._setExternalEditor(editor)
  }

  /**
   * Sets the user's preferred shell.
   */
  public setShell(shell: Shell): Promise<void> {
    return this.appStore._setShell(shell)
  }

  private async handleCloneInDesktopOptions(
    repository: Repository,
    action: IOpenRepositoryFromURLAction
  ): Promise<void> {
    const { filepath, pr, branch } = action

    if (pr != null && branch != null) {
      // we need to refetch for a forked PR and check that out
      await this.fetchRefspec(repository, `pull/${pr}/head:${branch}`)
    }

    if (pr == null && branch != null) {
      const state = this.appStore.getRepositoryState(repository)
      const branches = state.branchesState.allBranches

      // I don't want to invoke Git functionality from the dispatcher, which
      // would help by using getDefaultRemote here to get the definitive ref,
      // so this falls back to finding any remote branch matching the name
      // received from the "Clone in Desktop" action
      const localBranch =
        branches.find(b => b.upstreamWithoutRemote === branch) || null

      if (localBranch == null) {
        await this.fetch(repository, FetchType.BackgroundTask)
      }
    }

    if (branch != null) {
      await this.checkoutBranch(repository, branch)
    }

    if (filepath != null) {
      const fullPath = Path.join(repository.path, filepath)
      // because Windows uses different path separators here
      const normalized = Path.normalize(fullPath)
      shell.showItemInFolder(normalized)
    }
  }

  private async openRepository(
    url: string,
    branch: string | null
  ): Promise<Repository | null> {
    const state = this.appStore.getState()
    const repositories = state.repositories
    const existingRepository = repositories.find(r => {
      if (r instanceof Repository) {
        const gitHubRepository = r.gitHubRepository
        if (!gitHubRepository) {
          return false
        }
        return gitHubRepository.cloneURL === url
      } else {
        return false
      }
    })

    if (existingRepository) {
      const repo = await this.selectRepository(existingRepository)
      if (!repo || !branch) {
        return repo
      }

      return this.checkoutBranch(repo, branch)
    } else {
      return this.appStore._startOpenInDesktop(() => {
        this.changeCloneRepositoriesTab(CloneRepositoryTab.Generic)
        this.showPopup({
          type: PopupType.CloneRepository,
          initialURL: url,
        })
      })
    }
  }

  /**
   * Install the CLI tool.
   *
   * This is used only on macOS.
   */
  public async installCLI() {
    try {
      await installCLI()

      this.showPopup({ type: PopupType.CLIInstalled })
    } catch (e) {
      log.error('Error installing CLI', e)

      this.postError(e)
    }
  }

  /** Prompt the user to authenticate for a generic git server. */
  public promptForGenericGitAuthentication(
    repository: Repository | CloningRepository,
    retry: RetryAction
  ): Promise<void> {
    return this.appStore.promptForGenericGitAuthentication(repository, retry)
  }

  /** Save the generic git credentials. */
  public async saveGenericGitCredentials(
    hostname: string,
    username: string,
    password: string
  ): Promise<void> {
    log.info(`storing generic credentials for '${hostname}' and '${username}'`)
    setGenericUsername(hostname, username)

    try {
      await setGenericPassword(hostname, username, password)
    } catch (e) {
      log.error(
        `Error saving generic git credentials: ${username}@${hostname}`,
        e
      )

      this.postError(e)
    }
  }

  /** Perform the given retry action. */
  public async performRetry(retryAction: RetryAction): Promise<void> {
    switch (retryAction.type) {
      case RetryActionType.Push:
        return this.push(retryAction.repository)

      case RetryActionType.Pull:
        return this.pull(retryAction.repository)

      case RetryActionType.Fetch:
        return this.fetch(retryAction.repository, FetchType.UserInitiatedTask)

      case RetryActionType.Clone:
        await this.clone(retryAction.url, retryAction.path, retryAction.options)
        break

      default:
        return assertNever(retryAction, `Unknown retry action: ${retryAction}`)
    }
  }

  /** Change the selected image diff type. */
  public changeImageDiffType(type: ImageDiffType): Promise<void> {
    return this.appStore._changeImageDiffType(type)
  }

  /** Install the global Git LFS filters. */
  public installGlobalLFSFilters(force: boolean): Promise<void> {
    return this.appStore._installGlobalLFSFilters(force)
  }

  /** Install the LFS filters */
  public installLFSHooks(
    repositories: ReadonlyArray<Repository>
  ): Promise<void> {
    return this.appStore._installLFSHooks(repositories)
  }

  /** Change the selected Clone Repository tab. */
  public changeCloneRepositoriesTab(tab: CloneRepositoryTab): Promise<void> {
    return this.appStore._changeCloneRepositoriesTab(tab)
  }

  /** Open the merge tool for the given file. */
  public openMergeTool(repository: Repository, path: string): Promise<void> {
    return this.appStore._openMergeTool(repository, path)
  }

  /** Change the selected Branches foldout tab. */
  public changeBranchesTab(tab: BranchesTab): Promise<void> {
    return this.appStore._changeBranchesTab(tab)
  }
  /** Change the selected Items foldout tab. */
  public changeItemsTab(tab: ItemsTab): Promise<void> {
    return this.appStore._changeItemsTab(tab)
  }
  /**
   * Open the Create Pull Request page on GitHub after verifying ahead/behind.
   *
   * Note that this method will present the user with a dialog in case the
   * current branch in the repository is ahead or behind the remote.
   * The dialog lets the user choose whether get in sync with the remote
   * or open the PR anyway. This is distinct from the
   * openCreatePullRequestInBrowser method which immediately opens the
   * create pull request page without showing a dialog.
   */
  public createPullRequest(repository: Repository): Promise<void> {
    return this.appStore._createPullRequest(repository)
  }

  /**
   * Show the current pull request on github.com
   */
  public showPullRequest(repository: Repository): Promise<void> {
    return this.appStore._showPullRequest(repository)
  }

  /**
   * Immediately open the Create Pull Request page on GitHub.
   *
   * See the createPullRequest method for more details.
   */
  public openCreatePullRequestInBrowser(
    repository: Repository,
    branch: Branch
  ): Promise<void> {
    return this.appStore._openCreatePullRequestInBrowser(repository, branch)
  }

  /**
   * Update the existing `upstream` remote to point to the repository's parent.
   */
  public updateExistingUpstreamRemote(repository: Repository): Promise<void> {
    return this.appStore._updateExistingUpstreamRemote(repository)
  }

  /** Ignore the existing `upstream` remote. */
  public ignoreExistingUpstreamRemote(repository: Repository): Promise<void> {
    return this.appStore._ignoreExistingUpstreamRemote(repository)
  }

  /** Checks out a PR whose ref exists locally or in a forked repo. */
  public async checkoutPullRequest(
    repository: Repository,
    pullRequest: PullRequest
  ): Promise<void> {
    return this.appStore._checkoutPullRequest(repository, pullRequest)
  }

  /**
   * Set whether the user has chosen to hide or show the
   * co-authors field in the commit message component
   *
   * @param repository Co-author settings are per-repository
   */
  public setShowCoAuthoredBy(
    repository: Repository,
    showCoAuthoredBy: boolean
  ) {
    return this.appStore._setShowCoAuthoredBy(repository, showCoAuthoredBy)
  }

  /**
   * Update the per-repository co-authors list
   *
   * @param repository Co-author settings are per-repository
   * @param coAuthors  Zero or more authors
   */
  public setCoAuthors(
    repository: Repository,
    coAuthors: ReadonlyArray<IAuthor>
  ) {
    return this.appStore._setCoAuthors(repository, coAuthors)
  }

  /**
   * Initialze the compare state for the current repository.
   */
  public initializeCompare(
    repository: Repository,
    initialAction?: CompareAction
  ) {
    return this.appStore._initializeCompare(repository, initialAction)
  }

  /**
   * Update the compare state for the current repository
   */
  public executeCompare(repository: Repository, action: CompareAction) {
    return this.appStore._executeCompare(repository, action)
  }

  /** Update the compare form state for the current repository */
  public updateCompareForm<K extends keyof ICompareFormUpdate>(
    repository: Repository,
    newState: Pick<ICompareFormUpdate, K>
  ) {
    return this.appStore._updateCompareForm(repository, newState)
  }

  /**
   * Increments the `mergeIntoCurrentBranchMenuCount` metric
   */
  public recordMenuInitiatedMerge() {
    return this.appStore._recordMenuInitiatedMerge()
  }

  /**
   * Increments the `updateFromDefaultBranchMenuCount` metric
   */
  public recordMenuInitiatedUpdate() {
    return this.appStore._recordMenuInitiatedUpdate()
  }

  /**
   * Increments the `mergesInitiatedFromComparison` metric
   */
  public recordCompareInitiatedMerge() {
    return this.appStore._recordCompareInitiatedMerge()
  }
}
