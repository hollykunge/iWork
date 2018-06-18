import { expect } from 'chai'

import { groupRepositories } from '../../src/ui/repositories-list/group-repositories'
import { Repository } from '../../src/models/repository'
import { GitHubRepository } from '../../src/models/github-repository'
import { Owner } from '../../src/models/owner'
import { getDotComAPIEndpoint } from '../../src/lib/api'
import { CloningRepository } from '../../src/models/cloning-repository'

describe('repository list grouping', () => {
  const repositories: Array<Repository | CloningRepository> = [
    new Repository('repo1', 1, null, false),
    new Repository(
      'repo2',
      2,
      new GitHubRepository(
        'my-repo2',
        new Owner('', getDotComAPIEndpoint(), null),
        1
      ),
      false
    ),
    new Repository(
      'repo3',
      3,
      new GitHubRepository('my-repo3', new Owner('', '', null), 1),
      false
    ),
  ]

  it('groups repositories by GitHub/Enterprise/Other', () => {
    const grouped = groupRepositories(repositories)
    expect(grouped.length).to.equal(3)

    expect(grouped[0].identifier).to.equal('github')
    expect(grouped[0].items.length).to.equal(1)

    let item = grouped[0].items[0]
    expect(item.repository.path).to.equal('repo2')

    expect(grouped[1].identifier).to.equal('enterprise')
    expect(grouped[1].items.length).to.equal(1)

    item = grouped[1].items[0]
    expect(item.repository.path).to.equal('repo3')

    expect(grouped[2].identifier).to.equal('other')
    expect(grouped[2].items.length).to.equal(1)

    item = grouped[2].items[0]
    expect(item.repository.path).to.equal('repo1')
  })

  it('sorts repositories alphabetically within each group', () => {
    const repoA = new Repository('a', 1, null, false)
    const repoB = new Repository(
      'b',
      2,
      new GitHubRepository('b', new Owner('', getDotComAPIEndpoint(), null), 1),
      false
    )
    const repoC = new Repository('c', 2, null, false)
    const repoD = new Repository(
      'd',
      2,
      new GitHubRepository('d', new Owner('', getDotComAPIEndpoint(), null), 1),
      false
    )
    const repoZ = new Repository('z', 3, null, false)

    const grouped = groupRepositories([repoC, repoB, repoZ, repoD, repoA])
    expect(grouped.length).to.equal(2)

    expect(grouped[0].identifier).to.equal('github')
    expect(grouped[0].items.length).to.equal(2)

    let items = grouped[0].items
    expect(items[0].repository.path).to.equal('b')
    expect(items[1].repository.path).to.equal('d')

    expect(grouped[1].identifier).to.equal('other')
    expect(grouped[1].items.length).to.equal(3)

    items = grouped[1].items
    expect(items[0].repository.path).to.equal('a')
    expect(items[1].repository.path).to.equal('c')
    expect(items[2].repository.path).to.equal('z')
  })

  it('marks repositories for disambiguation if they have the same name', () => {
    const repoA = new Repository(
      'repo',
      1,
      new GitHubRepository(
        'repo',
        new Owner('user1', getDotComAPIEndpoint(), null),
        1
      ),
      false
    )
    const repoB = new Repository(
      'cool-repo',
      2,
      new GitHubRepository(
        'cool-repo',
        new Owner('user2', getDotComAPIEndpoint(), null),
        2
      ),
      false
    )
    const repoC = new Repository(
      'repo',
      2,
      new GitHubRepository(
        'repo',
        new Owner('user2', getDotComAPIEndpoint(), null),
        2
      ),
      false
    )

    const grouped = groupRepositories([repoA, repoB, repoC])
    expect(grouped.length).to.equal(1)

    expect(grouped[0].identifier).to.equal('github')
    expect(grouped[0].items.length).to.equal(3)

    const items = grouped[0].items
    expect(items[0].text[0]).to.equal('cool-repo')
    expect(items[0].needsDisambiguation).to.equal(false)

    expect(items[1].text[0]).to.equal('repo')
    expect(items[1].needsDisambiguation).to.equal(true)

    expect(items[2].text[0]).to.equal('repo')
    expect(items[2].needsDisambiguation).to.equal(true)
  })
})
