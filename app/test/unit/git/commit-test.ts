import * as path from 'path'
import * as FSE from 'fs-extra'

import { expect } from 'chai'

import { Repository } from '../../../src/models/repository'
import {
  getStatus,
  createCommit,
  getCommits,
  getCommit,
  getChangedFiles,
  getWorkingDirectoryDiff,
} from '../../../src/lib/git'

import {
  setupFixtureRepository,
  setupEmptyRepository,
  setupConflictedRepo,
} from '../../helpers/repositories'

import { GitProcess } from 'dugite'
import {
  AppFileStatus,
  WorkingDirectoryFileChange,
} from '../../../src/models/status'
import {
  DiffSelectionType,
  DiffSelection,
  ITextDiff,
  DiffType,
} from '../../../src/models/diff'

async function getTextDiff(
  repo: Repository,
  file: WorkingDirectoryFileChange
): Promise<ITextDiff> {
  const diff = await getWorkingDirectoryDiff(repo, file)
  expect(diff.kind === DiffType.Text)
  return diff as ITextDiff
}

describe('git/commit', () => {
  let repository: Repository | null = null

  beforeEach(async () => {
    const testRepoPath = await setupFixtureRepository('test-repo')
    repository = new Repository(testRepoPath, -1, null, false)
  })

  describe('createCommit normal', () => {
    it('commits the given files', async () => {
      await FSE.writeFile(
        path.join(repository!.path, 'README.md'),
        'Hi world\n'
      )

      let status = await getStatus(repository!)
      let files = status.workingDirectory.files
      expect(files.length).to.equal(1)

      await createCommit(repository!, 'Special commit', files)

      status = await getStatus(repository!)
      files = status.workingDirectory.files
      expect(files.length).to.equal(0)

      const commits = await getCommits(repository!, 'HEAD', 100)
      expect(commits.length).to.equal(6)
      expect(commits[0].summary).to.equal('Special commit')
    })

    it('commit does not strip commentary by default', async () => {
      await FSE.writeFile(
        path.join(repository!.path, 'README.md'),
        'Hi world\n'
      )

      const status = await getStatus(repository!)
      const files = status.workingDirectory.files
      expect(files.length).to.equal(1)

      const message = `Special commit

# this is a comment`

      await createCommit(repository!, message, files)

      const commit = await getCommit(repository!, 'HEAD')
      expect(commit).to.not.be.null
      expect(commit!.summary).to.equal('Special commit')
      expect(commit!.body).to.equal('# this is a comment\n')
    })

    it('can commit for empty repository', async () => {
      const repo = await setupEmptyRepository()

      await FSE.writeFile(path.join(repo.path, 'foo'), 'foo\n')
      await FSE.writeFile(path.join(repo.path, 'bar'), 'bar\n')

      const status = await getStatus(repo)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(2)

      const allChanges = [
        files[0].withIncludeAll(true),
        files[1].withIncludeAll(true),
      ]

      await createCommit(
        repo,
        'added two files\n\nthis is a description',
        allChanges
      )

      const statusAfter = await getStatus(repo)

      expect(statusAfter.workingDirectory.files.length).to.equal(0)

      const history = await getCommits(repo, 'HEAD', 2)

      expect(history.length).to.equal(1)
      expect(history[0].summary).to.equal('added two files')
      expect(history[0].body).to.equal('this is a description\n')
    })

    it('can commit renames', async () => {
      const repo = await setupEmptyRepository()

      await FSE.writeFile(path.join(repo.path, 'foo'), 'foo\n')

      await GitProcess.exec(['add', 'foo'], repo.path)
      await GitProcess.exec(['commit', '-m', 'Initial commit'], repo.path)
      await GitProcess.exec(['mv', 'foo', 'bar'], repo.path)

      const status = await getStatus(repo)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(1)

      await createCommit(repo, 'renamed a file', [
        files[0].withIncludeAll(true),
      ])

      const statusAfter = await getStatus(repo)

      expect(statusAfter.workingDirectory.files.length).to.equal(0)
    })
  })

  describe('createCommit partials', () => {
    beforeEach(async () => {
      const testRepoPath = await setupFixtureRepository('repo-with-changes')
      repository = new Repository(testRepoPath, -1, null, false)
    })

    it('can commit some lines from new file', async () => {
      const previousTip = (await getCommits(repository!, 'HEAD', 1))[0]

      const newFileName = 'new-file.md'

      // select first five lines of file
      const selection = DiffSelection.fromInitialSelection(
        DiffSelectionType.None
      ).withRangeSelection(0, 5, true)

      const file = new WorkingDirectoryFileChange(
        newFileName,
        AppFileStatus.New,
        selection
      )

      // commit just this change, ignore everything else
      await createCommit(repository!, 'title', [file])

      // verify that the HEAD of the repository has moved
      const newTip = (await getCommits(repository!, 'HEAD', 1))[0]
      expect(newTip.sha).to.not.equal(previousTip.sha)
      expect(newTip.summary).to.equal('title')

      // verify that the contents of this new commit are just the new file
      const changedFiles = await getChangedFiles(repository!, newTip.sha)
      expect(changedFiles.length).to.equal(1)
      expect(changedFiles[0].path).to.equal(newFileName)

      // verify that changes remain for this new file
      const status = await getStatus(repository!)
      expect(status.workingDirectory.files.length).to.equal(4)

      // verify that the file is now tracked
      const fileChange = status.workingDirectory.files.find(
        f => f.path === newFileName
      )
      expect(fileChange).to.not.be.undefined
      expect(fileChange!.status).to.equal(AppFileStatus.Modified)
    })

    it('can commit second hunk from modified file', async () => {
      const previousTip = (await getCommits(repository!, 'HEAD', 1))[0]

      const modifiedFile = 'modified-file.md'

      const unselectedFile = DiffSelection.fromInitialSelection(
        DiffSelectionType.None
      )
      const file = new WorkingDirectoryFileChange(
        modifiedFile,
        AppFileStatus.Modified,
        unselectedFile
      )

      const diff = await getTextDiff(repository!, file)

      const selection = DiffSelection.fromInitialSelection(
        DiffSelectionType.All
      ).withRangeSelection(
        diff.hunks[0].unifiedDiffStart,
        diff.hunks[0].unifiedDiffEnd - diff.hunks[0].unifiedDiffStart,
        false
      )

      const updatedFile = file.withSelection(selection)

      // commit just this change, ignore everything else
      await createCommit(repository!, 'title', [updatedFile])

      // verify that the HEAD of the repository has moved
      const newTip = (await getCommits(repository!, 'HEAD', 1))[0]
      expect(newTip.sha).to.not.equal(previousTip.sha)
      expect(newTip.summary).to.equal('title')

      // verify that the contents of this new commit are just the modified file
      const changedFiles = await getChangedFiles(repository!, newTip.sha)
      expect(changedFiles.length).to.equal(1)
      expect(changedFiles[0].path).to.equal(modifiedFile)

      // verify that changes remain for this modified file
      const status = await getStatus(repository!)
      expect(status.workingDirectory.files.length).to.equal(4)

      // verify that the file is still marked as modified
      const fileChange = status.workingDirectory.files.find(
        f => f.path === modifiedFile
      )
      expect(fileChange).to.not.be.undefined
      expect(fileChange!.status).to.equal(AppFileStatus.Modified)
    })

    it('can commit single delete from modified file', async () => {
      const previousTip = (await getCommits(repository!, 'HEAD', 1))[0]

      const fileName = 'modified-file.md'

      const unselectedFile = DiffSelection.fromInitialSelection(
        DiffSelectionType.None
      )
      const modifiedFile = new WorkingDirectoryFileChange(
        fileName,
        AppFileStatus.Modified,
        unselectedFile
      )

      const diff = await getTextDiff(repository!, modifiedFile)

      const secondRemovedLine = diff.hunks[0].unifiedDiffStart + 5

      const selection = DiffSelection.fromInitialSelection(
        DiffSelectionType.None
      ).withRangeSelection(secondRemovedLine, 1, true)

      const file = new WorkingDirectoryFileChange(
        fileName,
        AppFileStatus.Modified,
        selection
      )

      // commit just this change, ignore everything else
      await createCommit(repository!, 'title', [file])

      // verify that the HEAD of the repository has moved
      const newTip = (await getCommits(repository!, 'HEAD', 1))[0]
      expect(newTip.sha).to.not.equal(previousTip.sha)
      expect(newTip.summary).to.equal('title')

      // verify that the contents of this new commit are just the modified file
      const changedFiles = await getChangedFiles(repository!, newTip.sha)
      expect(changedFiles.length).to.equal(1)
      expect(changedFiles[0].path).to.equal(fileName)
    })

    it('can commit multiple hunks from modified file', async () => {
      const previousTip = (await getCommits(repository!, 'HEAD', 1))[0]

      const modifiedFile = 'modified-file.md'

      const unselectedFile = DiffSelection.fromInitialSelection(
        DiffSelectionType.None
      )
      const file = new WorkingDirectoryFileChange(
        modifiedFile,
        AppFileStatus.Modified,
        unselectedFile
      )

      const diff = await getTextDiff(repository!, file)

      const selection = DiffSelection.fromInitialSelection(
        DiffSelectionType.All
      ).withRangeSelection(
        diff.hunks[1].unifiedDiffStart,
        diff.hunks[1].unifiedDiffEnd - diff.hunks[1].unifiedDiffStart,
        false
      )

      const updatedFile = new WorkingDirectoryFileChange(
        modifiedFile,
        AppFileStatus.Modified,
        selection
      )

      // commit just this change, ignore everything else
      await createCommit(repository!, 'title', [updatedFile])

      // verify that the HEAD of the repository has moved
      const newTip = (await getCommits(repository!, 'HEAD', 1))[0]
      expect(newTip.sha).to.not.equal(previousTip.sha)
      expect(newTip.summary).to.equal('title')

      // verify that the contents of this new commit are just the modified file
      const changedFiles = await getChangedFiles(repository!, newTip.sha)
      expect(changedFiles.length).to.equal(1)
      expect(changedFiles[0].path).to.equal(modifiedFile)

      // verify that changes remain for this modified file
      const status = await getStatus(repository!)
      expect(status.workingDirectory.files.length).to.equal(4)

      // verify that the file is still marked as modified
      const fileChange = status.workingDirectory.files.find(
        f => f.path === modifiedFile
      )
      expect(fileChange).to.not.be.undefined
      expect(fileChange!.status).to.equal(AppFileStatus.Modified)
    })

    it('can commit some lines from deleted file', async () => {
      const previousTip = (await getCommits(repository!, 'HEAD', 1))[0]

      const deletedFile = 'deleted-file.md'

      const selection = DiffSelection.fromInitialSelection(
        DiffSelectionType.None
      ).withRangeSelection(0, 5, true)

      const file = new WorkingDirectoryFileChange(
        deletedFile,
        AppFileStatus.Deleted,
        selection
      )

      // commit just this change, ignore everything else
      await createCommit(repository!, 'title', [file])

      // verify that the HEAD of the repository has moved
      const newTip = (await getCommits(repository!, 'HEAD', 1))[0]
      expect(newTip.sha).to.not.equal(previousTip.sha)
      expect(newTip.summary).to.equal('title')

      // verify that the contents of this new commit are just the new file
      const changedFiles = await getChangedFiles(repository!, newTip.sha)
      expect(changedFiles.length).to.equal(1)
      expect(changedFiles[0].path).to.equal(deletedFile)

      // verify that changes remain for this new file
      const status = await getStatus(repository!)
      expect(status.workingDirectory.files.length).to.equal(4)

      // verify that the file is now tracked
      const fileChange = status.workingDirectory.files.find(
        f => f.path === deletedFile
      )
      expect(fileChange).to.not.be.undefined
      expect(fileChange!.status).to.equal(AppFileStatus.Deleted)
    })

    it('can commit renames with modifications', async () => {
      const repo = await setupEmptyRepository()

      await FSE.writeFile(path.join(repo.path, 'foo'), 'foo\n')

      await GitProcess.exec(['add', 'foo'], repo.path)
      await GitProcess.exec(['commit', '-m', 'Initial commit'], repo.path)
      await GitProcess.exec(['mv', 'foo', 'bar'], repo.path)

      await FSE.writeFile(path.join(repo.path, 'bar'), 'bar\n')

      const status = await getStatus(repo)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(1)

      await createCommit(repo, 'renamed a file', [
        files[0].withIncludeAll(true),
      ])

      const statusAfter = await getStatus(repo)

      expect(statusAfter.workingDirectory.files.length).to.equal(0)
    })

    // The scenario here is that the user has staged a rename (probably using git mv)
    // and then added some lines to the newly renamed file and they only want to
    // commit one of these lines.
    it('can commit renames with partially selected modifications', async () => {
      const repo = await setupEmptyRepository()

      await FSE.writeFile(path.join(repo.path, 'foo'), 'line1\n')

      await GitProcess.exec(['add', 'foo'], repo.path)
      await GitProcess.exec(['commit', '-m', 'Initial commit'], repo.path)
      await GitProcess.exec(['mv', 'foo', 'bar'], repo.path)

      await FSE.writeFile(path.join(repo.path, 'bar'), 'line1\nline2\nline3\n')

      const status = await getStatus(repo)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(1)
      expect(files[0].path).to.contain('bar')
      expect(files[0].status).to.equal(AppFileStatus.Renamed)

      const selection = files[0].selection
        .withSelectNone()
        .withLineSelection(2, true)

      const partiallySelectedFile = files[0].withSelection(selection)

      await createCommit(repo, 'renamed a file', [partiallySelectedFile])

      const statusAfter = await getStatus(repo)

      expect(statusAfter.workingDirectory.files.length).to.equal(1)

      const diff = await getTextDiff(
        repo,
        statusAfter.workingDirectory.files[0]
      )

      expect(diff.hunks.length).to.equal(1)
      expect(diff.hunks[0].lines.length).to.equal(4)
      expect(diff.hunks[0].lines[3].text).to.equal('+line3')
    })
  })

  describe('createCommit with a merge conflict', () => {
    it('creates a merge commit', async () => {
      const repo = await setupConflictedRepo()
      const filePath = path.join(repo.path, 'foo')

      const inMerge = await FSE.pathExists(
        path.join(repo.path, '.git', 'MERGE_HEAD')
      )
      expect(inMerge).to.equal(true)

      await FSE.writeFile(filePath, 'b1b2')

      const status = await getStatus(repo)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(1)
      expect(files[0].path).to.equal('foo')
      expect(files[0].status).to.equal(AppFileStatus.Conflicted)

      const selection = files[0].selection.withSelectAll()
      const selectedFile = files[0].withSelection(selection)
      await createCommit(repo, 'Merge commit!', [selectedFile])

      const commits = await getCommits(repo, 'HEAD', 5)
      expect(commits[0].parentSHAs.length).to.equal(2)
    })
  })

  describe('index corner cases', () => {
    it('can commit when staged new file is then deleted', async () => {
      let status,
        files = null

      const repo = await setupEmptyRepository()

      const firstPath = path.join(repo.path, 'first')
      const secondPath = path.join(repo.path, 'second')

      await FSE.writeFile(firstPath, 'line1\n')
      await FSE.writeFile(secondPath, 'line2\n')

      await GitProcess.exec(['add', '.'], repo.path)

      await FSE.unlink(firstPath)

      status = await getStatus(repo)
      files = status.workingDirectory.files

      expect(files.length).to.equal(1)
      expect(files[0].path).to.contain('second')
      expect(files[0].status).to.equal(AppFileStatus.New)

      const toCommit = status.workingDirectory.withIncludeAllFiles(true)

      await createCommit(repo, 'commit everything', toCommit.files)

      status = await getStatus(repo)
      files = status.workingDirectory.files
      expect(files).to.be.empty

      const commit = await getCommit(repo, 'HEAD')
      expect(commit).to.not.be.null
      expect(commit!.summary).to.equal('commit everything')
    })

    it('can commit when a delete is staged and the untracked file exists', async () => {
      let status,
        files = null

      const repo = await setupEmptyRepository()

      const firstPath = path.join(repo.path, 'first')
      await FSE.writeFile(firstPath, 'line1\n')

      await GitProcess.exec(['add', 'first'], repo.path)
      await GitProcess.exec(['commit', '-am', 'commit first file'], repo.path)
      await GitProcess.exec(['rm', '--cached', 'first'], repo.path)

      // if the text is now different, everything is fine
      await FSE.writeFile(firstPath, 'line2\n')

      status = await getStatus(repo)
      files = status.workingDirectory.files

      expect(files.length).to.equal(1)
      expect(files[0].path).to.contain('first')
      expect(files[0].status).to.equal(AppFileStatus.New)

      const toCommit = status.workingDirectory.withIncludeAllFiles(true)

      await createCommit(repo, 'commit again!', toCommit.files)

      status = await getStatus(repo)
      files = status.workingDirectory.files
      expect(files).to.be.empty

      const commit = await getCommit(repo, 'HEAD')
      expect(commit).to.not.be.null
      expect(commit!.summary).to.equal('commit again!')
    })
  })
})
