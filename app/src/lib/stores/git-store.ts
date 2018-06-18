import * as Fs from 'fs'
import * as Path from 'path'
import { Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { WorkingDirectoryFileChange, AppFileStatus } from '../../models/status'
import {
  Branch,
  BranchType,
  IAheadBehind,
  ICompareResult,
} from '../../models/branch'
import { Tip, TipState } from '../../models/tip'
import { Commit } from '../../models/commit'
import { IRemote } from '../../models/remote'
import { IFetchProgress, IRevertProgress, ComparisonView } from '../app-state'

import { IAppShell } from '../app-shell'
import { ErrorWithMetadata, IErrorMetadata } from '../error-with-metadata'
import { structuralEquals } from '../../lib/equality'
import { compare } from '../../lib/compare'
import { queueWorkHigh } from '../../lib/queue-work'

import {
  reset,
  GitResetMode,
  getRemotes,
  fetch as fetchRepo,
  fetchRefspec,
  getRecentBranches,
  getBranches,
  deleteRef,
  getCommits,
  merge,
  setRemoteURL,
  getStatus,
  IStatusResult,
  getCommit,
  IndexStatus,
  getIndexChanges,
  checkoutIndex,
  checkoutPaths,
  resetPaths,
  revertCommit,
  unstageAllFiles,
  openMergeTool,
  addRemote,
  listSubmodules,
  resetSubmodulePaths,
  parseTrailers,
  mergeTrailers,
  getTrailerSeparatorCharacters,
  parseSingleUnfoldedTrailer,
  isCoAuthoredByTrailer,
  getAheadBehind,
  revRange,
  revSymmetricDifference,
} from '../git'
import { IGitAccount } from '../git/authentication'
import { RetryAction, RetryActionType } from '../retry-actions'
import { UpstreamAlreadyExistsError } from './upstream-already-exists-error'
import { forceUnwrap } from '../fatal-error'
import {
  findUpstreamRemote,
  UpstreamRemoteName,
} from './helpers/find-upstream-remote'
import { findDefaultRemote } from './helpers/find-default-remote'
import { IAuthor } from '../../models/author'
import { formatCommitMessage } from '../format-commit-message'
import { GitAuthor } from '../../models/git-author'
import { BaseStore } from './base-store'

/** The number of commits to load from history per batch. */
const CommitBatchSize = 100

const LoadingHistoryRequestKey = 'history'

/** The max number of recent branches to find. */
const RecentBranchesLimit = 5

/** A commit message summary and description. */
export interface ICommitMessage {
  readonly summary: string
  readonly description: string | null
}

/** The store for a repository's git data. */
export class GitStore extends BaseStore {
  private readonly shell: IAppShell

  /** The commits keyed by their SHA. */
  public readonly commitLookup = new Map<string, Commit>()

  private _history: ReadonlyArray<string> = new Array()

  private readonly requestsInFight = new Set<string>()

  private readonly repository: Repository

  private _tip: Tip = { kind: TipState.Unknown }

  private _defaultBranch: Branch | null = null

  private _allBranches: ReadonlyArray<Branch> = []

  private _recentBranches: ReadonlyArray<Branch> = []

  private _localCommitSHAs: ReadonlyArray<string> = []

  private _commitMessage: ICommitMessage | null = null

  private _contextualCommitMessage: ICommitMessage | null = null

  private _showCoAuthoredBy: boolean = false

  private _coAuthors: ReadonlyArray<IAuthor> = []

  private _aheadBehind: IAheadBehind | null = null

  private _defaultRemote: IRemote | null = null

  private _remote: IRemote | null = null

  private _upstream: IRemote | null = null

  private _lastFetched: Date | null = null

  public constructor(repository: Repository, shell: IAppShell) {
    super()

    this.repository = repository
    this.shell = shell
  }

  private emitNewCommitsLoaded(commits: ReadonlyArray<Commit>) {
    this.emitter.emit('did-load-new-commits', commits)
  }

  /** Register a function to be called when the store loads new commits. */
  public onDidLoadNewCommits(
    fn: (commits: ReadonlyArray<Commit>) => void
  ): Disposable {
    return this.emitter.on('did-load-new-commits', fn)
  }

  /**
   * Reconcile the local history view with the repository state
   * after a pull has completed, to include merged remote commits.
   */
  public async reconcileHistory(mergeBase: string): Promise<void> {
    if (this._history.length === 0) {
      return
    }

    if (this.requestsInFight.has(LoadingHistoryRequestKey)) {
      return
    }

    this.requestsInFight.add(LoadingHistoryRequestKey)

    const range = revRange('HEAD', mergeBase)

    const commits = await this.performFailableOperation(() =>
      getCommits(this.repository, range, CommitBatchSize)
    )
    if (commits == null) {
      return
    }

    const existingHistory = this._history
    const index = existingHistory.findIndex(c => c === mergeBase)

    if (index > -1) {
      log.debug(
        `reconciling history - adding ${
          commits.length
        } commits before merge base ${mergeBase.substr(0, 8)}`
      )

      // rebuild the local history state by combining the commits _before_ the
      // merge base with the current commits on the tip of this current branch
      const remainingHistory = existingHistory.slice(index)
      this._history = [...commits.map(c => c.sha), ...remainingHistory]
    }

    this.storeCommits(commits, true)
    this.requestsInFight.delete(LoadingHistoryRequestKey)
    this.emitUpdate()
  }

  /** Load history from HEAD. */
  public async loadHistory() {
    if (this.requestsInFight.has(LoadingHistoryRequestKey)) {
      return
    }

    this.requestsInFight.add(LoadingHistoryRequestKey)

    let commits = await this.performFailableOperation(() =>
      getCommits(this.repository, 'HEAD', CommitBatchSize)
    )
    if (!commits) {
      return
    }

    let existingHistory = this._history
    if (existingHistory.length > 0) {
      const mostRecent = existingHistory[0]
      const index = commits.findIndex(c => c.sha === mostRecent)
      // If we found the old HEAD, then we can just splice the new commits into
      // the history we already loaded.
      //
      // But if we didn't, it means the history we had and the history we just
      // loaded have diverged significantly or in some non-trivial way
      // (e.g., HEAD reset). So just throw it out and we'll start over fresh.
      if (index > -1) {
        commits = commits.slice(0, index)
      } else {
        existingHistory = []
      }
    }

    this._history = [...commits.map(c => c.sha), ...existingHistory]
    this.storeCommits(commits, true)
    this.requestsInFight.delete(LoadingHistoryRequestKey)
    this.emitUpdate()
  }

  /** Load the next batch of history, starting from the last loaded commit. */
  public async loadNextHistoryBatch() {
    if (this.requestsInFight.has(LoadingHistoryRequestKey)) {
      return
    }

    if (!this.history.length) {
      return
    }

    const lastSHA = this.history[this.history.length - 1]
    const requestKey = `history/${lastSHA}`
    if (this.requestsInFight.has(requestKey)) {
      return
    }

    this.requestsInFight.add(requestKey)

    const commits = await this.performFailableOperation(() =>
      getCommits(this.repository, `${lastSHA}^`, CommitBatchSize)
    )
    if (!commits) {
      return
    }

    this._history = this._history.concat(commits.map(c => c.sha))
    this.storeCommits(commits, true)
    this.requestsInFight.delete(requestKey)
    this.emitUpdate()
  }

  /** The list of ordered SHAs. */
  public get history(): ReadonlyArray<string> {
    return this._history
  }

  /** Load all the branches. */
  public async loadBranches() {
    const [localAndRemoteBranches, recentBranchNames] = await Promise.all([
      this.performFailableOperation(() => getBranches(this.repository)) || [],
      this.performFailableOperation(() =>
        getRecentBranches(this.repository, RecentBranchesLimit)
      ),
    ])

    if (!localAndRemoteBranches) {
      return
    }

    this._allBranches = this.mergeRemoteAndLocalBranches(localAndRemoteBranches)

    this.refreshDefaultBranch()
    this.refreshRecentBranches(recentBranchNames)

    const commits = this._allBranches.map(b => b.tip)

    for (const commit of commits) {
      this.commitLookup.set(commit.sha, commit)
    }

    this.emitNewCommitsLoaded(commits)
    this.emitUpdate()
  }

  /**
   * Takes a list of local and remote branches and filters out "duplicate"
   * remote branches, i.e. remote branches that we already have a local
   * branch tracking.
   */
  private mergeRemoteAndLocalBranches(
    branches: ReadonlyArray<Branch>
  ): ReadonlyArray<Branch> {
    const localBranches = new Array<Branch>()
    const remoteBranches = new Array<Branch>()

    for (const branch of branches) {
      if (branch.type === BranchType.Local) {
        localBranches.push(branch)
      } else if (branch.type === BranchType.Remote) {
        remoteBranches.push(branch)
      }
    }

    const upstreamBranchesAdded = new Set<string>()
    const allBranchesWithUpstream = new Array<Branch>()

    for (const branch of localBranches) {
      allBranchesWithUpstream.push(branch)

      if (branch.upstream) {
        upstreamBranchesAdded.add(branch.upstream)
      }
    }

    for (const branch of remoteBranches) {
      // This means we already added the local branch of this remote branch, so
      // we don't need to add it again.
      if (upstreamBranchesAdded.has(branch.name)) {
        continue
      }

      allBranchesWithUpstream.push(branch)
    }

    return allBranchesWithUpstream
  }

  private refreshDefaultBranch() {
    let defaultBranchName: string | null = 'master'
    const gitHubRepository = this.repository.gitHubRepository
    if (gitHubRepository && gitHubRepository.defaultBranch) {
      defaultBranchName = gitHubRepository.defaultBranch
    }

    if (defaultBranchName) {
      // Find the default branch among all of our branches, giving
      // priority to local branches by sorting them before remotes
      this._defaultBranch =
        this._allBranches
          .filter(b => b.name === defaultBranchName)
          .sort((x, y) => compare(x.type, y.type))
          .shift() || null
    } else {
      this._defaultBranch = null
    }
  }

  private refreshRecentBranches(
    recentBranchNames: ReadonlyArray<string> | undefined
  ) {
    if (!recentBranchNames || !recentBranchNames.length) {
      this._recentBranches = []
      return
    }

    const branchesByName = this._allBranches.reduce(
      (map, branch) => map.set(branch.name, branch),
      new Map<string, Branch>()
    )

    const recentBranches = new Array<Branch>()
    for (const name of recentBranchNames) {
      const branch = branchesByName.get(name)
      if (!branch) {
        // This means the recent branch has been deleted. That's fine.
        continue
      }

      recentBranches.push(branch)
    }

    this._recentBranches = recentBranches
  }

  /** The current branch. */
  public get tip(): Tip {
    return this._tip
  }

  /** The default branch, or `master` if there is no default. */
  public get defaultBranch(): Branch | null {
    return this._defaultBranch
  }

  /** All branches, including the current branch and the default branch. */
  public get allBranches(): ReadonlyArray<Branch> {
    return this._allBranches
  }

  /** The most recently checked out branches. */
  public get recentBranches(): ReadonlyArray<Branch> {
    return this._recentBranches
  }

  /**
   * Load local commits into memory for the current repository.
   *
   * @param branch The branch to query for unpublished commits.
   *
   * If the tip of the repository does not have commits (i.e. is unborn), this
   * should be invoked with `null`, which clears any existing commits from the
   * store.
   */
  public async loadLocalCommits(branch: Branch | null): Promise<void> {
    if (branch === null) {
      this._localCommitSHAs = []
      return
    }

    let localCommits: ReadonlyArray<Commit> | undefined
    if (branch.upstream) {
      const range = revRange(branch.upstream, branch.name)
      localCommits = await this.performFailableOperation(() =>
        getCommits(this.repository, range, CommitBatchSize)
      )
    } else {
      localCommits = await this.performFailableOperation(() =>
        getCommits(this.repository, 'HEAD', CommitBatchSize, [
          '--not',
          '--remotes',
        ])
      )
    }

    if (!localCommits) {
      return
    }

    this.storeCommits(localCommits)
    this._localCommitSHAs = localCommits.map(c => c.sha)
    this.emitUpdate()
  }

  /**
   * The ordered array of local commit SHAs. The commits themselves can be
   * looked up in `commits`.
   */
  public get localCommitSHAs(): ReadonlyArray<string> {
    return this._localCommitSHAs
  }

  /** Store the given commits. */
  private storeCommits(
    commits: ReadonlyArray<Commit>,
    emitUpdate: boolean = false
  ) {
    for (const commit of commits) {
      this.commitLookup.set(commit.sha, commit)
    }

    if (emitUpdate) {
      this.emitNewCommitsLoaded(commits)
    }
  }

  private async undoFirstCommit(
    repository: Repository
  ): Promise<true | undefined> {
    // What are we doing here?
    // The state of the working directory here is rather important, because we
    // want to ensure that any deleted files are restored to your working
    // directory for the next stage. Doing doing a `git checkout -- .` here
    // isn't suitable because we should preserve the other working directory
    // changes.
    const status = await getStatus(repository)
    const paths = status.workingDirectory.files

    const deletedFiles = paths.filter(p => p.status === AppFileStatus.Deleted)
    const deletedFilePaths = deletedFiles.map(d => d.path)

    await checkoutPaths(repository, deletedFilePaths)

    // Now that we have the working directory changes, as well the restored
    // deleted files, we can remove the HEAD ref to make the current branch
    // disappear
    await deleteRef(repository, 'HEAD', 'Reverting first commit')

    // Finally, ensure any changes in the index are unstaged. This ensures all
    // files in the repository will be untracked.
    await unstageAllFiles(repository)
    return true
  }

  /**
   * Undo a specific commit for the current repository.
   *
   * @param commit - The commit to remove - should be the tip of the current branch.
   */
  public async undoCommit(commit: Commit): Promise<void> {
    // For an initial commit, just delete the reference but leave HEAD. This
    // will make the branch unborn again.
    const success = await this.performFailableOperation(
      () =>
        commit.parentSHAs.length === 0
          ? this.undoFirstCommit(this.repository)
          : reset(this.repository, GitResetMode.Mixed, commit.parentSHAs[0])
    )

    if (success === undefined) {
      return
    }

    // Let's be safe about this since it's untried waters.
    // If we can restore co-authors then that's fantastic
    // but if we can't we shouldn't be throwing an error,
    // let's just fall back to the old way of restoring the
    // entire message
    if (this.repository.gitHubRepository) {
      try {
        await this.loadCommitAndCoAuthors(commit)
        this.emitUpdate()
        return
      } catch (e) {
        log.error('Failed to restore commit and co-authors, falling back', e)
      }
    }

    this._contextualCommitMessage = {
      summary: commit.summary,
      description: commit.body,
    }
    this.emitUpdate()
  }

  /**
   * Attempt to restore both the commit message and any co-authors
   * in it after an undo operation.
   *
   * This is a deceivingly simple task which complicated by the
   * us wanting to follow the heuristics of Git when finding, and
   * parsing trailers.
   */
  private async loadCommitAndCoAuthors(commit: Commit) {
    const repository = this.repository

    // git-interpret-trailers is really only made for working
    // with full commit messages so let's start with that
    const message = await formatCommitMessage(
      repository,
      commit.summary,
      commit.body,
      []
    )

    // Next we extract any co-authored-by trailers we
    // can find. We use interpret-trailers for this
    const foundTrailers = await parseTrailers(repository, message)
    const coAuthorTrailers = foundTrailers.filter(isCoAuthoredByTrailer)

    // This is the happy path, nothing more for us to do
    if (coAuthorTrailers.length === 0) {
      this._contextualCommitMessage = {
        summary: commit.summary,
        description: commit.body,
      }

      return
    }

    // call interpret-trailers --unfold so that we can be sure each
    // trailer sits on a single line
    const unfolded = await mergeTrailers(repository, message, [], true)
    const lines = unfolded.split('\n')

    // We don't know (I mean, we're fairly sure) what the separator character
    // used for the trailer is so we call out to git to get all possible
    // characters. We'll need them in a bit
    const separators = await getTrailerSeparatorCharacters(this.repository)

    // We know that what we've got now is well formed so we can capture the leading
    // token, followed by the separator char and a single space, followed by the
    // value
    const coAuthorRe = /^co-authored-by(.)\s(.*)/i
    const extractedTrailers = []

    // Iterate backwards from the unfolded message and look for trailers that we've
    // already seen when calling parseTrailers earlier.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      const match = coAuthorRe.exec(line)

      // Not a trailer line, we're sure of that
      if (!match || separators.indexOf(match[1]) === -1) {
        continue
      }

      const trailer = parseSingleUnfoldedTrailer(line, match[1])

      if (!trailer) {
        continue
      }

      // We already know that the key is Co-Authored-By so we only
      // need to compare by value. Let's see if we can find the thing
      // that we believe to be a trailer among what interpret-trailers
      // --parse told us was a trailer. This step is a bit redundant
      // but it ensure we match exactly with what Git thinks is a trailer
      const foundTrailerIx = coAuthorTrailers.findIndex(
        t => t.value === trailer.value
      )

      if (foundTrailerIx === -1) {
        continue
      }

      // We're running backwards
      extractedTrailers.unshift(coAuthorTrailers[foundTrailerIx])

      // Remove the trailer that matched so that we can be sure
      // we're not picking it up again
      coAuthorTrailers.splice(foundTrailerIx, 1)

      // This line was a co-author trailer so we'll remove it to
      // make sure it doesn't end up in the restored commit body
      lines.splice(i, 1)
    }

    // Get rid of the summary/title
    lines.splice(0, 2)

    const newBody = lines.join('\n').trim()

    this._contextualCommitMessage = {
      summary: commit.summary,
      description: newBody,
    }

    const extractedAuthors = extractedTrailers.map(t =>
      GitAuthor.parse(t.value)
    )
    const newAuthors = new Array<IAuthor>()

    // Last step, phew! The most likely scenario where we
    // get called is when someone has just made a commit and
    // either forgot to add a co-author or forgot to remove
    // someone so chances are high that we already have a
    // co-author which includes a username. If we don't we'll
    // add it without a username which is fine as well
    for (let i = 0; i < extractedAuthors.length; i++) {
      const extractedAuthor = extractedAuthors[i]

      // If GitAuthor failed to parse
      if (extractedAuthor === null) {
        continue
      }

      const { name, email } = extractedAuthor
      const existing = this.coAuthors.find(
        a => a.name === name && a.email === email && a.username !== null
      )
      newAuthors.push(existing || { name, email, username: null })
    }

    this._coAuthors = newAuthors

    if (this._coAuthors.length > 0 && this._showCoAuthoredBy === false) {
      this._showCoAuthoredBy = true
    }
  }

  /**
   * Perform an operation that may fail by throwing an error. If an error is
   * thrown, catch it and emit it, and return `undefined`.
   *
   * @param errorMetadata - The metadata which should be attached to any errors
   *                        that are thrown.
   */
  public async performFailableOperation<T>(
    fn: () => Promise<T>,
    errorMetadata?: IErrorMetadata
  ): Promise<T | undefined> {
    try {
      const result = await fn()
      return result
    } catch (e) {
      e = new ErrorWithMetadata(e, {
        repository: this.repository,
        ...errorMetadata,
      })

      this.emitError(e)
      return undefined
    }
  }

  /** The commit message for a work-in-progress commit in the changes view. */
  public get commitMessage(): ICommitMessage | null {
    return this._commitMessage
  }

  /**
   * The commit message to use based on the contex of the repository, e.g., the
   * message from a recently undone commit.
   */
  public get contextualCommitMessage(): ICommitMessage | null {
    return this._contextualCommitMessage
  }

  /**
   * Gets a value indicating whether the user has chosen to
   * hide or show the co-authors field in the commit message
   * component
   */
  public get showCoAuthoredBy(): boolean {
    return this._showCoAuthoredBy
  }

  /**
   * Gets a list of co-authors to use when crafting the next
   * commit.
   */
  public get coAuthors(): ReadonlyArray<IAuthor> {
    return this._coAuthors
  }

  /**
   * Fetch the default, current, and upstream remotes, using the given account for
   * authentication.
   *
   * @param account          - The account to use for authentication if needed.
   * @param backgroundTask   - Was the fetch done as part of a background task?
   * @param progressCallback - A function that's called with information about
   *                           the overall fetch progress.
   */
  public async fetch(
    account: IGitAccount | null,
    backgroundTask: boolean,
    progressCallback?: (fetchProgress: IFetchProgress) => void
  ): Promise<void> {
    // Use a map as a simple way of getting a unique set of remotes.
    // Note that maps iterate in insertion order so the order in which
    // we insert these will affect the order in which we fetch them
    const remotes = new Map<string, IRemote>()

    // We want to fetch the current remote first
    if (this.remote) {
      remotes.set(this.remote.name, this.remote)
    }

    // And then the default remote if it differs from the current
    if (this.defaultRemote) {
      remotes.set(this.defaultRemote.name, this.defaultRemote)
    }

    // And finally the upstream if we're a fork
    if (this.upstream) {
      remotes.set(this.upstream.name, this.upstream)
    }

    if (remotes.size > 0) {
      await this.fetchRemotes(
        account,
        [...remotes.values()],
        backgroundTask,
        progressCallback
      )
    }
  }

  /**
   * Fetch the specified remotes, using the given account for authentication.
   *
   * @param account          - The account to use for authentication if needed.
   * @param remotes          - The remotes to fetch from.
   * @param backgroundTask   - Was the fetch done as part of a background task?
   * @param progressCallback - A function that's called with information about
   *                           the overall fetch progress.
   */
  public async fetchRemotes(
    account: IGitAccount | null,
    remotes: ReadonlyArray<IRemote>,
    backgroundTask: boolean,
    progressCallback?: (fetchProgress: IFetchProgress) => void
  ): Promise<void> {
    if (!remotes.length) {
      return
    }

    const weight = 1 / remotes.length

    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i]
      const startProgressValue = i * weight

      await this.fetchRemote(account, remote.name, backgroundTask, progress => {
        if (progress && progressCallback) {
          progressCallback({
            ...progress,
            value: startProgressValue + progress.value * weight,
          })
        }
      })
    }
  }

  /**
   * Fetch a remote, using the given account for authentication.
   *
   * @param account          - The account to use for authentication if needed.
   * @param remote           - The name of the remote to fetch from.
   * @param backgroundTask   - Was the fetch done as part of a background task?
   * @param progressCallback - A function that's called with information about
   *                           the overall fetch progress.
   */
  public async fetchRemote(
    account: IGitAccount | null,
    remote: string,
    backgroundTask: boolean,
    progressCallback?: (fetchProgress: IFetchProgress) => void
  ): Promise<void> {
    const retryAction: RetryAction = {
      type: RetryActionType.Fetch,
      repository: this.repository,
    }
    await this.performFailableOperation(
      () => {
        return fetchRepo(this.repository, account, remote, progressCallback)
      },
      { backgroundTask, retryAction }
    )
  }

  /**
   * Fetch a given refspec, using the given account for authentication.
   *
   * @param user - The user to use for authentication if needed.
   * @param refspec - The association between a remote and local ref to use as
   *                  part of this action. Refer to git-scm for more
   *                  information on refspecs: https://www.git-scm.com/book/tr/v2/Git-Internals-The-Refspec
   *
   */
  public async fetchRefspec(
    account: IGitAccount | null,
    refspec: string
  ): Promise<void> {
    // TODO: we should favour origin here
    const remotes = await getRemotes(this.repository)

    for (const remote of remotes) {
      await this.performFailableOperation(() =>
        fetchRefspec(this.repository, account, remote.name, refspec)
      )
    }
  }

  public async loadStatus(): Promise<IStatusResult | null> {
    const status = await this.performFailableOperation(() =>
      getStatus(this.repository)
    )

    if (!status) {
      return null
    }

    this._aheadBehind = status.branchAheadBehind || null

    const { currentBranch, currentTip } = status

    if (currentBranch || currentTip) {
      if (currentTip && currentBranch) {
        const cachedCommit = this.commitLookup.get(currentTip)
        const branchTipCommit =
          cachedCommit ||
          (await this.performFailableOperation(() =>
            getCommit(this.repository, currentTip)
          ))

        if (!branchTipCommit) {
          throw new Error(`Could not load commit ${currentTip}`)
        }

        const branch = new Branch(
          currentBranch,
          status.currentUpstreamBranch || null,
          branchTipCommit,
          BranchType.Local
        )
        this._tip = { kind: TipState.Valid, branch }
      } else if (currentTip) {
        this._tip = { kind: TipState.Detached, currentSha: currentTip }
      } else if (currentBranch) {
        this._tip = { kind: TipState.Unborn, ref: currentBranch }
      }
    } else {
      this._tip = { kind: TipState.Unknown }
    }

    this.emitUpdate()

    return status
  }

  public async loadRemotes(): Promise<void> {
    const remotes = await getRemotes(this.repository)
    this._defaultRemote = findDefaultRemote(remotes)

    const currentRemoteName =
      this.tip.kind === TipState.Valid && this.tip.branch.remote !== null
        ? this.tip.branch.remote
        : null

    // Load the remote that the current branch is tracking. If the branch
    // is not tracking any remote or the remote which it's tracking has
    // been removed we'll default to the default branch.
    this._remote =
      currentRemoteName !== null
        ? remotes.find(r => r.name === currentRemoteName) || this._defaultRemote
        : this._defaultRemote

    const parent =
      this.repository.gitHubRepository &&
      this.repository.gitHubRepository.parent

    this._upstream = parent ? findUpstreamRemote(parent, remotes) : null

    this.emitUpdate()
  }

  /**
   * Add the upstream remote if the repository is a fork and an upstream remote
   * doesn't already exist.
   */
  public async addUpstreamRemoteIfNeeded(): Promise<void> {
    const parent =
      this.repository.gitHubRepository &&
      this.repository.gitHubRepository.parent
    if (!parent) {
      return
    }

    const remotes = await getRemotes(this.repository)
    const upstream = findUpstreamRemote(parent, remotes)
    if (upstream) {
      return
    }

    const remoteWithUpstreamName = remotes.find(
      r => r.name === UpstreamRemoteName
    )
    if (remoteWithUpstreamName) {
      const error = new UpstreamAlreadyExistsError(
        this.repository,
        remoteWithUpstreamName
      )
      this.emitError(error)
      return
    }

    const url = forceUnwrap(
      'Parent repositories are fully loaded',
      parent.cloneURL
    )

    await this.performFailableOperation(() =>
      addRemote(this.repository, UpstreamRemoteName, url)
    )
    this._upstream = { name: UpstreamRemoteName, url }
  }

  /**
   * The number of commits the current branch is ahead and behind, relative to
   * its upstream.
   *
   * It will be `null` if ahead/behind hasn't been calculated yet, or if the
   * branch doesn't have an upstream.
   */
  public get aheadBehind(): IAheadBehind | null {
    return this._aheadBehind
  }

  /** Get the remote we're working with. */
  public get defaultRemote(): IRemote | null {
    return this._defaultRemote
  }

  /** Get the remote we're working with. */
  public get remote(): IRemote | null {
    return this._remote
  }

  /**
   * Get the remote for the upstream repository. This will be null if the
   * repository isn't a fork, or if the fork doesn't have an upstream remote.
   */
  public get upstream(): IRemote | null {
    return this._upstream
  }

  /**
   * Set whether the user has chosen to hide or show the
   * co-authors field in the commit message component
   */
  public setShowCoAuthoredBy(showCoAuthoredBy: boolean) {
    this._showCoAuthoredBy = showCoAuthoredBy
    // Clear co-authors when hiding
    if (!showCoAuthoredBy) {
      this._coAuthors = []
    }
    this.emitUpdate()
  }

  /**
   * Update co-authors list
   *
   * @param coAuthors  Zero or more authors
   */
  public setCoAuthors(coAuthors: ReadonlyArray<IAuthor>) {
    this._coAuthors = coAuthors
    this.emitUpdate()
  }

  public setCommitMessage(message: ICommitMessage | null): Promise<void> {
    this._commitMessage = message
    this.emitUpdate()
    return Promise.resolve()
  }

  /** The date the repository was last fetched. */
  public get lastFetched(): Date | null {
    return this._lastFetched
  }

  /** Update the last fetched date. */
  public updateLastFetched(): Promise<void> {
    const path = Path.join(this.repository.path, '.git', 'FETCH_HEAD')
    return new Promise<void>((resolve, reject) => {
      Fs.stat(path, (err, stats) => {
        if (err) {
          // An error most likely means the repository's never been published.
          this._lastFetched = null
        } else if (stats.size > 0) {
          // If the file's empty then it _probably_ means the fetch failed and we
          // shouldn't update the last fetched date.
          this._lastFetched = stats.mtime
        }

        resolve()

        this.emitUpdate()
      })
    })
  }

  /** Merge the named branch into the current branch. */
  public merge(branch: string): Promise<void> {
    return this.performFailableOperation(() => merge(this.repository, branch))
  }

  /** Changes the URL for the remote that matches the given name  */
  public async setRemoteURL(name: string, url: string): Promise<void> {
    await this.performFailableOperation(() =>
      setRemoteURL(this.repository, name, url)
    )
    await this.loadRemotes()

    this.emitUpdate()
  }

  public async discardChanges(
    files: ReadonlyArray<WorkingDirectoryFileChange>
  ): Promise<void> {
    const pathsToCheckout = new Array<string>()
    const pathsToReset = new Array<string>()

    const submodules = await listSubmodules(this.repository)

    await queueWorkHigh(files, async file => {
      const foundSubmodule = submodules.some(s => s.path === file.path)

      if (file.status !== AppFileStatus.Deleted && !foundSubmodule) {
        // N.B. moveItemToTrash is synchronous can take a fair bit of time
        // which is why we're running it inside this work queue that spreads
        // out the calls across as many animation frames as it needs to.
        this.shell.moveItemToTrash(
          Path.resolve(this.repository.path, file.path)
        )
      }

      if (
        file.status === AppFileStatus.Copied ||
        file.status === AppFileStatus.Renamed
      ) {
        // file.path is the "destination" or "new" file in a copy or rename.
        // we've already deleted it so all we need to do is make sure the
        // index forgets about it.
        pathsToReset.push(file.path)

        // Checkout the old path though
        if (file.oldPath) {
          pathsToCheckout.push(file.oldPath)
          pathsToReset.push(file.oldPath)
        }
      } else {
        pathsToCheckout.push(file.path)
        pathsToReset.push(file.path)
      }
    })

    // Check the index to see which files actually have changes there as compared to HEAD
    const changedFilesInIndex = await getIndexChanges(this.repository)

    // Only reset paths if they have changes in the index
    const necessaryPathsToReset = pathsToReset.filter(x =>
      changedFilesInIndex.has(x)
    )

    const submodulePaths = pathsToCheckout.filter(p =>
      submodules.find(s => s.path === p)
    )

    // Don't attempt to checkout files that are submodules or don't exist in the index after our reset
    const necessaryPathsToCheckout = pathsToCheckout.filter(
      x =>
        submodulePaths.indexOf(x) === -1 ||
        changedFilesInIndex.get(x) !== IndexStatus.Added
    )

    // We're trying to not invoke git linearly with the number of files to discard
    // so we're doing our discards in three conceptual steps.
    //
    // 1. Figure out what the index thinks has changed as compared to the previous
    //    commit. For users who exclusive interact with Git using Desktop this will
    //    almost always empty which, as it turns out, is great for us.
    //
    // 2. Figure out if any of the files that we've been asked to discard are changed
    //    in the index and if so, reset them such that the index is set up just as
    //    the previous commit for the paths we're discarding.
    //
    // 3. Checkout all the files that we've discarded that existed in the previous
    //    commit from the index.
    await this.performFailableOperation(async () => {
      await resetSubmodulePaths(this.repository, submodulePaths)
      await resetPaths(
        this.repository,
        GitResetMode.Mixed,
        'HEAD',
        necessaryPathsToReset
      )
      await checkoutIndex(this.repository, necessaryPathsToCheckout)
    })
  }

  /** Load the contextual commit message if there is one. */
  public async loadContextualCommitMessage(): Promise<void> {
    const message = await this.getMergeMessage()
    const existingMessage = this._contextualCommitMessage
    // In the case where we're in the middle of a merge, we're gonna keep
    // finding the same merge message over and over. We don't need to keep
    // telling the world.
    if (
      existingMessage &&
      message &&
      structuralEquals(existingMessage, message)
    ) {
      return
    }

    this._contextualCommitMessage = message
    this.emitUpdate()
  }

  /** Reverts the commit with the given SHA */
  public async revertCommit(
    repository: Repository,
    commit: Commit,
    account: IGitAccount | null,
    progressCallback?: (fetchProgress: IRevertProgress) => void
  ): Promise<void> {
    await this.performFailableOperation(() =>
      revertCommit(repository, commit, account, progressCallback)
    )

    this.emitUpdate()
  }

  /**
   * Get the merge message in the repository. This will resolve to null if the
   * repository isn't in the middle of a merge.
   */
  private async getMergeMessage(): Promise<ICommitMessage | null> {
    const messagePath = Path.join(this.repository.path, '.git', 'MERGE_MSG')
    return new Promise<ICommitMessage | null>((resolve, reject) => {
      Fs.readFile(messagePath, 'utf8', (err, data) => {
        if (err || !data.length) {
          resolve(null)
        } else {
          const pieces = data.match(/(.*)\n\n([\S\s]*)/m)
          if (!pieces || pieces.length < 3) {
            resolve(null)
            return
          }

          // exclude any commented-out lines from the MERGE_MSG body
          let description: string | null = pieces[2]
            .split('\n')
            .filter(line => line[0] !== '#')
            .join('\n')

          // join with no elements will return an empty string
          if (description.length === 0) {
            description = null
          }

          resolve({
            summary: pieces[1],
            description,
          })
        }
      })
    })
  }

  public async openMergeTool(path: string): Promise<void> {
    await this.performFailableOperation(() =>
      openMergeTool(this.repository, path)
    )
  }

  /**
   * Update the repository's existing upstream remote to point to the parent
   * repository.
   */
  public async updateExistingUpstreamRemote(): Promise<void> {
    const gitHubRepository = forceUnwrap(
      'To update an upstream remote, the repository must be a GitHub repository',
      this.repository.gitHubRepository
    )
    const parent = forceUnwrap(
      'To update an upstream remote, the repository must have a parent',
      gitHubRepository.parent
    )
    const url = forceUnwrap(
      'Parent repositories are always fully loaded',
      parent.cloneURL
    )

    await this.performFailableOperation(() =>
      setRemoteURL(this.repository, UpstreamRemoteName, url)
    )
  }

  /**
   * Returns the commits associated with `branch` and ahead/behind info;
   */
  public async getCompareCommits(
    branch: Branch,
    compareType: ComparisonView.Ahead | ComparisonView.Behind
  ): Promise<ICompareResult | null> {
    if (this.tip.kind !== TipState.Valid) {
      return null
    }

    const base = this.tip.branch
    const aheadBehind = await getAheadBehind(
      this.repository,
      revSymmetricDifference(base.name, branch.name)
    )

    if (aheadBehind == null) {
      return null
    }

    const revisionRange =
      compareType === ComparisonView.Ahead
        ? revRange(branch.name, base.name)
        : revRange(base.name, branch.name)
    const commitsToLoad =
      compareType === ComparisonView.Ahead
        ? aheadBehind.ahead
        : aheadBehind.behind
    const commits = await getCommits(
      this.repository,
      revisionRange,
      commitsToLoad
    )

    if (commits.length > 0) {
      this.storeCommits(commits, true)
    }

    return {
      commits,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
    }
  }
}
