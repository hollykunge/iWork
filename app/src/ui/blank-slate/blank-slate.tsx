import * as React from 'react'
import { encodePathAsUrl } from '../../lib/path'
import { UiView } from '../ui-view'
import { Button } from '../lib/button'
import { Octicon, OcticonSymbol } from '../octicons'

interface IBlankSlateProps {
  /** A function to call when the user chooses to create a repository. */
  readonly onCreate: () => void

  /** A function to call when the user chooses to clone a repository. */
  readonly onClone: () => void

  /** A function to call when the user chooses to add a local repository. */
  readonly onAdd: () => void
}

const BlankSlateImageUrl = encodePathAsUrl(
  __dirname,
  'static/empty-no-repo.svg'
)

const ImageStyle: React.CSSProperties = {
  backgroundImage: `url(${BlankSlateImageUrl})`,
}

/**
 * The blank slate view. This is shown when the user hasn't added any
 * repositories to the app.
 */
export class BlankSlateView extends React.Component<IBlankSlateProps, {}> {
  public render() {
    return (
      <UiView id="blank-slate">
        <div className="blankslate-image" style={ImageStyle} />

        <div className="content">
          <div className="title">
            {__DARWIN__ ? '找不到任务包' : '找不到任务包'}
          </div>

          <div className="callouts">
            <div className="callout">
              <Octicon symbol={OcticonSymbol.plus} />
              <div>创建一个任务并推送到WorkHub上</div>
              <Button onClick={this.props.onCreate}>
                {__DARWIN__ ? '创建新的任务包' : '创建新的任务包'}
              </Button>
            </div>

            <div className="callout">
              <Octicon symbol={OcticonSymbol.deviceDesktop} />
              <div>添加一个已经存在的任务包</div>
              <Button onClick={this.props.onAdd}>
                {__DARWIN__ ? '添加本地任务包' : '添加本地任务包'}
              </Button>
            </div>

            <div className="callout">
              <Octicon symbol={OcticonSymbol.repoClone} />
              <div>获取一个在WorkHub上的任务包</div>
              <Button onClick={this.props.onClone}>
                {__DARWIN__ ? '获取任务包' : '获取任务包'}
              </Button>
            </div>
          </div>
        </div>

        <p className="footer">你也可以拖拽任务包到当前位置</p>
      </UiView>
    )
  }
}
