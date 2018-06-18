import { IGitHubUser } from '../lib/databases/github-user-database'
import { Commit } from './commit'
import { CommitIdentity } from './commit-identity'
import { GitAuthor } from './git-author'
import { generateGravatarUrl } from '../lib/gravatar'
import { getDotComAPIEndpoint } from '../lib/api'
import { GitHubRepository } from './github-repository'

/** The minimum properties we need in order to display a user's avatar. */
export interface IAvatarUser {
  /** The user's email. */
  readonly email: string

  /** The user's avatar URL. */
  readonly avatarURL: string

  /** The user's name. */
  readonly name: string
}

function getFallbackAvatarUrlForAuthor(
  gitHubRepository: GitHubRepository | null,
  author: CommitIdentity | GitAuthor
) {
  if (
    gitHubRepository &&
    gitHubRepository.endpoint === getDotComAPIEndpoint()
  ) {
    return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(
      author.email
    )}&s=60`
  }

  return generateGravatarUrl(author.email)
}

function getAvatarUserFromAuthor(
  gitHubRepository: GitHubRepository | null,
  gitHubUsers: Map<string, IGitHubUser> | null,
  author: CommitIdentity | GitAuthor
) {
  const gitHubUser =
    gitHubUsers === null
      ? null
      : gitHubUsers.get(author.email.toLowerCase()) || null

  const avatarURL = gitHubUser
    ? gitHubUser.avatarURL
    : getFallbackAvatarUrlForAuthor(gitHubRepository, author)

  return {
    email: author.email,
    name: author.name,
    avatarURL,
  }
}

/**
 * Attempt to look up avatars for all authors (and committer)
 * of a particular commit.
 *
 * Avatars are returned ordered, starting with the author, followed
 * by all co-authors and finally the committer (if different from
 * author).
 *
 * @param gitHubRepository
 * @param gitHubUsers
 * @param commit
 */
export function getAvatarUsersForCommit(
  gitHubRepository: GitHubRepository | null,
  gitHubUsers: Map<string, IGitHubUser> | null,
  commit: Commit
) {
  const avatarUsers = []

  avatarUsers.push(
    getAvatarUserFromAuthor(gitHubRepository, gitHubUsers, commit.author)
  )
  avatarUsers.push(
    ...commit.coAuthors.map(x =>
      getAvatarUserFromAuthor(gitHubRepository, gitHubUsers, x)
    )
  )

  const isWebFlowCommitter =
    gitHubRepository !== null && commit.isWebFlowCommitter(gitHubRepository)

  if (!commit.authoredByCommitter && !isWebFlowCommitter) {
    avatarUsers.push(
      getAvatarUserFromAuthor(gitHubRepository, gitHubUsers, commit.committer)
    )
  }

  return avatarUsers
}
