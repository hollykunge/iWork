import { expect } from 'chai'

import { RepositoriesStore } from '../../src/lib/stores/repositories-store'
import { TestRepositoriesDatabase } from '../helpers/databases'
import { IAPIRepository } from '../../src/lib/api'

describe('RepositoriesStore', () => {
  let repositoriesStore: RepositoriesStore | null = null

  beforeEach(async () => {
    const db = new TestRepositoriesDatabase()
    await db.reset()

    repositoriesStore = new RepositoriesStore(db)
  })

  describe('adding a new repository', () => {
    it('contains the added repository', async () => {
      const repoPath = '/some/cool/path'
      await repositoriesStore!.addRepository(repoPath)

      const repositories = await repositoriesStore!.getAll()
      expect(repositories[0].path).to.equal(repoPath)
    })
  })

  describe('getting all repositories', () => {
    it('returns multiple repositories', async () => {
      await repositoriesStore!.addRepository('/some/cool/path')
      await repositoriesStore!.addRepository('/some/other/path')

      const repositories = await repositoriesStore!.getAll()
      expect(repositories.length).to.equal(2)
    })
  })

  describe('updating a GitHub repository', () => {
    const gitHubRepo: IAPIRepository = {
      clone_url: 'https://github.com/my-user/my-repo',
      html_url: 'https://github.com/my-user/my-repo',
      name: 'my-repo',
      owner: {
        id: 42,
        url: 'https://github.com/my-user',
        login: 'my-user',
        avatar_url: 'https://github.com/my-user.png',
        email: 'my-user@users.noreply.github.com',
        name: 'My User',
        type: 'User',
      },
      private: true,
      fork: false,
      default_branch: 'master',
      parent: null,
    }

    it('adds a new GitHub repository', async () => {
      const addedRepo = await repositoriesStore!.addRepository(
        '/some/cool/path'
      )

      await repositoriesStore!.updateGitHubRepository(
        addedRepo,
        'https://api.github.com',
        gitHubRepo
      )

      const repositories = await repositoriesStore!.getAll()
      const repo = repositories[0]
      expect(repo.gitHubRepository!.private).to.equal(true)
      expect(repo.gitHubRepository!.fork).to.equal(false)
      expect(repo.gitHubRepository!.htmlURL).to.equal(
        'https://github.com/my-user/my-repo'
      )
    })

    it('reuses an existing GitHub repository', async () => {
      const firstRepo = await repositoriesStore!.addRepository(
        '/some/cool/path'
      )
      const updatedFirstRepo = await repositoriesStore!.updateGitHubRepository(
        firstRepo,
        'https://api.github.com',
        gitHubRepo
      )

      const secondRepo = await repositoriesStore!.addRepository(
        '/some/other/path'
      )
      const updatedSecondRepo = await repositoriesStore!.updateGitHubRepository(
        secondRepo,
        'https://api.github.com',
        gitHubRepo
      )

      expect(updatedFirstRepo.gitHubRepository!.dbID).to.equal(
        updatedSecondRepo.gitHubRepository!.dbID
      )
    })
  })
})
