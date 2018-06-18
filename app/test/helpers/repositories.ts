/* eslint-disable no-sync */

import * as Path from 'path'
import * as FSE from 'fs-extra'

const klawSync = require('klaw-sync')

import { Repository } from '../../src/models/repository'
import { GitProcess } from 'dugite'

type KlawEntry = {
  path: string
}

import * as temp from 'temp'
const _temp = temp.track()

export const mkdirSync = _temp.mkdirSync
export const openSync = _temp.openSync

/**
 * Set up the named fixture repository to be used in a test.
 *
 * @returns The path to the set up fixture repository.
 */
export async function setupFixtureRepository(
  repositoryName: string
): Promise<string> {
  const testRepoFixturePath = Path.join(
    __dirname,
    '..',
    'fixtures',
    repositoryName
  )
  const testRepoPath = _temp.mkdirSync('desktop-git-test-')
  await FSE.copy(testRepoFixturePath, testRepoPath)

  await FSE.rename(
    Path.join(testRepoPath, '_git'),
    Path.join(testRepoPath, '.git')
  )

  const ignoreHiddenFiles = function(item: KlawEntry) {
    const basename = Path.basename(item.path)
    return basename === '.' || basename[0] !== '.'
  }

  const entries: ReadonlyArray<KlawEntry> = klawSync(testRepoPath)
  const visiblePaths = entries.filter(ignoreHiddenFiles)
  const submodules = visiblePaths.filter(
    entry => Path.basename(entry.path) === '_git'
  )

  for (const submodule of submodules) {
    const directory = Path.dirname(submodule.path)
    const newPath = Path.join(directory, '.git')
    await FSE.rename(submodule.path, newPath)
  }

  return testRepoPath
}

/**
 * Initializes a new, empty, git repository at in a temporary location.
 *
 * @returns the new local repository
 */
export async function setupEmptyRepository(): Promise<Repository> {
  const repoPath = _temp.mkdirSync('desktop-empty-repo-')
  await GitProcess.exec(['init'], repoPath)

  return new Repository(repoPath, -1, null, false)
}

/**
 * Setup a repository and create a merge conflict
 *
 * @returns the new local repository
 *
 * The current branch will be 'other-branch' and the merged branch will be
 * 'master' in your test harness.
 *
 * The conflicted file will be 'foo'.
 */
export async function setupConflictedRepo(): Promise<Repository> {
  const repo = await setupEmptyRepository()
  const filePath = Path.join(repo.path, 'foo')

  await FSE.writeFile(filePath, '')
  await GitProcess.exec(['add', 'foo'], repo.path)
  await GitProcess.exec(['commit', '-m', 'Commit'], repo.path)

  await GitProcess.exec(['branch', 'other-branch'], repo.path)

  await FSE.writeFile(filePath, 'b1')
  await GitProcess.exec(['add', 'foo'], repo.path)
  await GitProcess.exec(['commit', '-m', 'Commit'], repo.path)

  await GitProcess.exec(['checkout', 'other-branch'], repo.path)

  await FSE.writeFile(filePath, 'b2')
  await GitProcess.exec(['add', 'foo'], repo.path)
  await GitProcess.exec(['commit', '-m', 'Commit'], repo.path)

  await GitProcess.exec(['merge', 'master'], repo.path)

  return repo
}
