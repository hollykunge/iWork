import * as React from 'react'
import { encodePathAsUrl } from '../../lib/path'
import { Ref } from '../lib/ref'
import { LinkButton } from '../lib/link-button'

const BlankSlateImage = encodePathAsUrl(
  __dirname,
  'static/empty-no-pull-requests.svg'
)

interface INoPullRequestsProps {
  /** The name of the repository. */
  readonly repositoryName: string

  /** Is the default branch currently checked out? */
  readonly isOnDefaultBranch: boolean

  /** Is this component being rendered due to a search? */
  readonly isSearch: boolean

  /* Called when the user wants to create a new branch. */
  readonly onCreateBranch: () => void

  /** Called when the user wants to create a pull request. */
  readonly onCreatePullRequest: () => void
}

/** The placeholder for when there are no open pull requests. */
export class NoPullRequests extends React.Component<INoPullRequestsProps, {}> {
  public render() {
    return (
      <div className="no-pull-requests">
        <img src={BlankSlateImage} className="blankslate-image" />
        {this.renderTitle()}
        {this.renderCallToAction()}
      </div>
    )
  }

  private renderTitle() {
    if (this.props.isSearch) {
      return <div className="title">Sorry, I can't find that pull request!</div>
    } else {
      return (
        <div>
          <div className="title">You're all set!</div>
          <div className="no-prs">
            No open pull requests in <Ref>{this.props.repositoryName}</Ref>
          </div>
        </div>
      )
    }
  }

  private renderCallToAction() {
    if (this.props.isOnDefaultBranch) {
      return (
        <div className="call-to-action">
          Would you like to{' '}
          <LinkButton onClick={this.props.onCreateBranch}>
            create a new branch
          </LinkButton>{' '}
          and get going on your next project?
        </div>
      )
    } else {
      return (
        <div className="call-to-action">
          你是否想要在当前分支任务上{' '}
          <LinkButton onClick={this.props.onCreatePullRequest}>
            创建一个推送请求
          </LinkButton>{' '}
          ?
        </div>
      )
    }
  }
}
