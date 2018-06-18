import { DiffSelection, DiffSelectionType } from './diff'
import { OcticonSymbol } from '../ui/octicons'
import { assertNever } from '../lib/fatal-error'

/**
 * The status entry code as reported by Git.
 */
export enum GitStatusEntry {
  // M
  Modified,
  // A
  Added,
  // D
  Deleted,
  // R
  Renamed,
  // C
  Copied,
  // .
  Unchanged,
  // ?
  Untracked,
  // !
  Ignored,
  // U
  //
  // While U is a valid code here, we currently mark conflicts as "Modified"
  // in the application - this will likely be something we need to revisit
  // down the track as we improve our merge conflict experience
  UpdatedButUnmerged,
}

/** The file status as represented in GitHub Desktop. */
export enum AppFileStatus {
  New,
  Modified,
  Deleted,
  Copied,
  Renamed,
  Conflicted,
}

/** The porcelain status for an ordinary changed entry */
type OrdinaryEntry = {
  readonly kind: 'ordinary'
  /** how we should represent the file in the application */
  readonly type: 'added' | 'modified' | 'deleted'
  /** the status of the index for this entry (if known) */
  readonly index?: GitStatusEntry
  /** the status of the working tree for this entry (if known) */
  readonly workingTree?: GitStatusEntry
}

/** The porcelain status for a renamed or copied entry */
type RenamedOrCopiedEntry = {
  readonly kind: 'renamed' | 'copied'
  /** the status of the index for this entry (if known) */
  readonly index?: GitStatusEntry
  /** the status of the working tree for this entry (if known) */
  readonly workingTree?: GitStatusEntry
}

/** The porcelain status for an unmerged entry */
type UnmergedEntry = {
  readonly kind: 'conflicted'
  /** the first character of the short code ("ours")  */
  readonly us: GitStatusEntry
  /** the second character of the short code ("theirs")  */
  readonly them: GitStatusEntry
}

/** The porcelain status for an unmerged entry */
type UntrackedEntry = {
  readonly kind: 'untracked'
}

/** The union of possible entries from the git status */
export type FileEntry =
  | OrdinaryEntry
  | RenamedOrCopiedEntry
  | UnmergedEntry
  | UntrackedEntry

/**
 * Convert a given FileStatus value to a human-readable string to be
 * presented to users which describes the state of a file.
 *
 * Typically this will be the same value as that of the enum key.
 *
 * Used in file lists.
 */
export function mapStatus(status: AppFileStatus): string {
  switch (status) {
    case AppFileStatus.New:
      return 'New'
    case AppFileStatus.Modified:
      return 'Modified'
    case AppFileStatus.Deleted:
      return 'Deleted'
    case AppFileStatus.Renamed:
      return 'Renamed'
    case AppFileStatus.Conflicted:
      return 'Conflicted'
    case AppFileStatus.Copied:
      return 'Copied'
  }

  return assertNever(status, `Unknown file status ${status}`)
}

/**
 * Converts a given FileStatus value to an Octicon symbol
 * presented to users when displaying the file path.
 *
 * Used in file lists.
 */
export function iconForStatus(status: AppFileStatus): OcticonSymbol {
  switch (status) {
    case AppFileStatus.New:
      return OcticonSymbol.diffAdded
    case AppFileStatus.Modified:
      return OcticonSymbol.diffModified
    case AppFileStatus.Deleted:
      return OcticonSymbol.diffRemoved
    case AppFileStatus.Renamed:
      return OcticonSymbol.diffRenamed
    case AppFileStatus.Conflicted:
      return OcticonSymbol.alert
    case AppFileStatus.Copied:
      return OcticonSymbol.diffAdded
  }

  return assertNever(status, `Unknown file status ${status}`)
}

/** encapsulate changes to a file associated with a commit */
export class FileChange {
  /** the relative path to the file in the repository */
  public readonly path: string

  /** The original path in the case of a renamed file */
  public readonly oldPath?: string

  /** the status of the change to the file */
  public readonly status: AppFileStatus

  /** An ID for the file change. */
  public readonly id: string

  public constructor(path: string, status: AppFileStatus, oldPath?: string) {
    this.path = path
    this.status = status
    this.oldPath = oldPath
    this.id = `${this.status}+${this.path}`
  }
}

/** encapsulate the changes to a file in the working directory */
export class WorkingDirectoryFileChange extends FileChange {
  /** contains the selection details for this file - all, nothing or partial */
  public readonly selection: DiffSelection

  public constructor(
    path: string,
    status: AppFileStatus,
    selection: DiffSelection,
    oldPath?: string
  ) {
    super(path, status, oldPath)

    this.selection = selection
  }

  /** Create a new WorkingDirectoryFileChange with the given includedness. */
  public withIncludeAll(include: boolean): WorkingDirectoryFileChange {
    const newSelection = include
      ? this.selection.withSelectAll()
      : this.selection.withSelectNone()

    return this.withSelection(newSelection)
  }

  /** Create a new WorkingDirectoryFileChange with the given diff selection. */
  public withSelection(selection: DiffSelection): WorkingDirectoryFileChange {
    return new WorkingDirectoryFileChange(
      this.path,
      this.status,
      selection,
      this.oldPath
    )
  }
}

/**
 * An object encapsulating the changes to a committed file.
 */
export class CommittedFileChange extends FileChange {
  /**
   * A commit SHA or some other identifier that ultimately
   * dereferences to a commit. This is the pointer to the
   * 'after' version of this change. I.e. the parent of this
   * commit will contain the 'before' (or nothing, if the
   * file change represents a new file).
   */
  public readonly commitish: string

  public constructor(
    path: string,
    status: AppFileStatus,
    commitish: string,
    oldPath?: string
  ) {
    super(path, status, oldPath)

    this.commitish = commitish
  }
}

/** the state of the working directory for a repository */
export class WorkingDirectoryStatus {
  /**
   * The list of changes in the repository's working directory
   */
  public readonly files: ReadonlyArray<WorkingDirectoryFileChange> = []

  private readonly fileIxById = new Map<string, number>()

  /**
   * Update the include checkbox state of the form
   * NOTE: we need to track this separately to the file list selection
   *       and perform two-way binding manually when this changes
   */
  public readonly includeAll: boolean | null = true

  /** Create a new status with the given files. */
  public static fromFiles(
    files: ReadonlyArray<WorkingDirectoryFileChange>
  ): WorkingDirectoryStatus {
    return new WorkingDirectoryStatus(files, getIncludeAllState(files))
  }

  private constructor(
    files: ReadonlyArray<WorkingDirectoryFileChange>,
    includeAll: boolean | null
  ) {
    this.files = files
    files.forEach((f, ix) => this.fileIxById.set(f.id, ix))

    this.includeAll = includeAll
  }

  /**
   * Update the include state of all files in the working directory
   */
  public withIncludeAllFiles(includeAll: boolean): WorkingDirectoryStatus {
    const newFiles = this.files.map(f => f.withIncludeAll(includeAll))
    return new WorkingDirectoryStatus(newFiles, includeAll)
  }

  /** Find the file with the given ID. */
  public findFileWithID(id: string): WorkingDirectoryFileChange | null {
    const ix = this.fileIxById.get(id)
    return ix !== undefined ? this.files[ix] || null : null
  }

  /** Find the index of the file with the given ID. Returns -1 if not found */
  public findFileIndexByID(id: string): number {
    const ix = this.fileIxById.get(id)
    return ix !== undefined ? ix : -1
  }
}

function getIncludeAllState(
  files: ReadonlyArray<WorkingDirectoryFileChange>
): boolean | null {
  if (!files.length) {
    return true
  }

  const allSelected = files.every(
    f => f.selection.getSelectionType() === DiffSelectionType.All
  )
  const noneSelected = files.every(
    f => f.selection.getSelectionType() === DiffSelectionType.None
  )

  let includeAll: boolean | null = null
  if (allSelected) {
    includeAll = true
  } else if (noneSelected) {
    includeAll = false
  }

  return includeAll
}
