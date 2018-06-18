import * as React from 'react'

import { encodePathAsUrl } from '../../lib/path'
import { revealInFileManager } from '../../lib/app-shell'
import { Repository } from '../../models/repository'
import { LinkButton } from '../lib/link-button'

const BlankSlateImage = encodePathAsUrl(
  __dirname,
  'static/empty-no-file-selected.svg'
)

interface INoChangesProps {
  readonly repository: Repository
}

/** The component to display when there are no local changes. */
export class NoChanges extends React.Component<INoChangesProps, {}> {
  public render() {
    const opener = __DARWIN__
      ? 'Finder'
      : __WIN32__
        ? 'Explorer'
        : 'your File Manager'
    return (
      <div className="panel blankslate" id="no-changes">
        <img src={BlankSlateImage} className="blankslate-image" />
        <div>无本地文件变更</div>

        <div>
          你想要在{opener}中
          <LinkButton onClick={this.open}>打开任务</LinkButton>吗?
        </div>
      </div>
    )
  }

  private open = () => {
    revealInFileManager(this.props.repository, '')
  }
}
