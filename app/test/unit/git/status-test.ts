import * as path from 'path'
import { expect } from 'chai'
import * as FSE from 'fs-extra'
import { GitProcess } from 'dugite'

import { Repository } from '../../../src/models/repository'
import { getStatus } from '../../../src/lib/git/status'
import {
  setupFixtureRepository,
  setupEmptyRepository,
} from '../../helpers/repositories'
import { AppFileStatus } from '../../../src/models/status'

describe('git/status', () => {
  let repository: Repository | null = null

  beforeEach(async () => {
    const testRepoPath = await setupFixtureRepository('test-repo')
    repository = new Repository(testRepoPath, -1, null, false)
  })

  describe('getStatus', () => {
    it('parses changed files', async () => {
      await FSE.writeFile(
        path.join(repository!.path, 'README.md'),
        'Hi world\n'
      )

      const status = await getStatus(repository!)
      const files = status.workingDirectory.files
      expect(files.length).to.equal(1)

      const file = files[0]
      expect(file.path).to.equal('README.md')
      expect(file.status).to.equal(AppFileStatus.Modified)
    })

    it('returns an empty array when there are no changes', async () => {
      const status = await getStatus(repository!)
      const files = status.workingDirectory.files
      expect(files.length).to.equal(0)
    })

    it('reflects renames', async () => {
      const repo = await setupEmptyRepository()

      await FSE.writeFile(path.join(repo.path, 'foo'), 'foo\n')

      await GitProcess.exec(['add', 'foo'], repo.path)
      await GitProcess.exec(['commit', '-m', 'Initial commit'], repo.path)
      await GitProcess.exec(['mv', 'foo', 'bar'], repo.path)

      const status = await getStatus(repo)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(1)
      expect(files[0].status).to.equal(AppFileStatus.Renamed)
      expect(files[0].oldPath).to.equal('foo')
      expect(files[0].path).to.equal('bar')
    })

    it('reflects copies', async () => {
      const testRepoPath = await setupFixtureRepository('copy-detection-status')
      repository = new Repository(testRepoPath, -1, null, false)

      await GitProcess.exec(['add', '.'], repository.path)

      const status = await getStatus(repository)
      const files = status.workingDirectory.files

      expect(files.length).to.equal(2)

      expect(files[0].status).to.equal(AppFileStatus.Modified)
      expect(files[0].oldPath).to.be.undefined
      expect(files[0].path).to.equal('CONTRIBUTING.md')

      expect(files[1].status).to.equal(AppFileStatus.Copied)
      expect(files[1].oldPath).to.equal('CONTRIBUTING.md')
      expect(files[1].path).to.equal('docs/OVERVIEW.md')
    })
  })
})
