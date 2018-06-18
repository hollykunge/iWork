import { expect } from 'chai'
import { shell } from '../../helpers/test-app-shell'
import {
  setupEmptyRepository,
  setupFixtureRepository,
} from '../../helpers/repositories'

import { Repository } from '../../../src/models/repository'
import { checkoutBranch, getBranches, createBranch } from '../../../src/lib/git'
import { TipState, IValidBranch } from '../../../src/models/tip'
import { GitStore } from '../../../src/lib/stores'
import { Branch, BranchType } from '../../../src/models/branch'

describe('git/checkout', () => {
  it('throws when invalid characters are used for branch name', async () => {
    const repository = await setupEmptyRepository()

    const branch: Branch = {
      name: '..',
      nameWithoutRemote: '..',
      upstream: null,
      upstreamWithoutRemote: null,
      type: BranchType.Local,
      tip: {
        sha: '',
        summary: '',
        body: '',
        author: {
          name: '',
          email: '',
          date: new Date(),
          tzOffset: 0,
        },
        committer: {
          name: '',
          email: '',
          date: new Date(),
          tzOffset: 0,
        },
        authoredByCommitter: true,
        parentSHAs: [],
        trailers: [],
        coAuthors: [],
        isWebFlowCommitter: () => false,
      },
      remote: null,
    }

    let errorRaised = false
    try {
      await checkoutBranch(repository, null, branch)
    } catch (error) {
      errorRaised = true
      expect(error.message).to.equal('fatal: invalid reference: ..\n')
    }

    expect(errorRaised).to.be.true
  })

  it('can checkout a valid branch name in an existing repository', async () => {
    const path = await setupFixtureRepository('repo-with-many-refs')
    const repository = new Repository(path, -1, null, false)

    const branches = await getBranches(
      repository,
      'refs/heads/commit-with-long-description'
    )

    if (branches.length === 0) {
      throw new Error(`Could not find branch: commit-with-long-description`)
    }

    await checkoutBranch(repository, null, branches[0])

    const store = new GitStore(repository, shell)
    await store.loadStatus()
    const tip = store.tip

    expect(tip.kind).to.equal(TipState.Valid)

    const validBranch = tip as IValidBranch
    expect(validBranch.branch.name).to.equal('commit-with-long-description')
  })

  it('can checkout a branch when it exists on multiple remotes', async () => {
    const path = await setupFixtureRepository('checkout-test-cases')
    const repository = new Repository(path, -1, null, false)

    const expectedBranch = 'first'
    const firstRemote = 'first-remote'
    const secondRemote = 'second-remote'

    const branches = await getBranches(repository)
    const firstBranch = `${firstRemote}/${expectedBranch}`
    const firstRemoteBranch = branches.find(b => b.name === firstBranch)

    if (firstRemoteBranch == null) {
      throw new Error(`Could not find branch: '${firstBranch}'`)
    }

    const secondBranch = `${secondRemote}/${expectedBranch}`
    const secondRemoteBranch = branches.find(b => b.name === secondBranch)

    if (secondRemoteBranch == null) {
      throw new Error(`Could not find branch: '${secondBranch}'`)
    }

    await checkoutBranch(repository, null, firstRemoteBranch)

    const store = new GitStore(repository, shell)
    await store.loadStatus()
    const tip = store.tip

    expect(tip.kind).to.equal(TipState.Valid)

    const validBranch = tip as IValidBranch
    expect(validBranch.branch.name).to.equal(expectedBranch)
    expect(validBranch.branch.type).to.equal(BranchType.Local)
    expect(validBranch.branch.remote).to.equal('first-remote')
  })

  it('will fail when an existing branch matches the remote branch', async () => {
    const path = await setupFixtureRepository('checkout-test-cases')
    const repository = new Repository(path, -1, null, false)

    const expectedBranch = 'first'
    const firstRemote = 'first-remote'

    const branches = await getBranches(repository)
    const firstBranch = `${firstRemote}/${expectedBranch}`
    const remoteBranch = branches.find(b => b.name === firstBranch)

    if (remoteBranch == null) {
      throw new Error(`Could not find branch: '${firstBranch}'`)
    }

    await createBranch(repository, expectedBranch)

    let errorRaised = false

    try {
      await checkoutBranch(repository, null, remoteBranch)
    } catch (error) {
      errorRaised = true
      expect(error.message).to.equal('A branch with that name already exists.')
    }

    expect(errorRaised).to.be.true
  })
})
