import * as React from 'react'

import { IMatches } from '../../lib/fuzzy-find'

import { Octicon, OcticonSymbol } from '../octicons'
import { HighlightText } from '../lib/highlight-text'

interface IItemListItemProps {
  /** 类型名称 */
  readonly name: string

  /** 指定当前是否选中此项 */
  readonly isCurrentItem: boolean

  /** 在选项名称中突出显示的字符 */
  readonly matches: IMatches
}

/** 添加类型文件下拉列表 */
export class ItemListItem extends React.Component<IItemListItemProps, {}> {
  public render() {
    const isCurrentItem = this.props.isCurrentItem
    const name = this.props.name

    const icon = isCurrentItem ? OcticonSymbol.check : OcticonSymbol.gitBranch
    const infoTitle = isCurrentItem ? '新建文件' : ''
    return (
      <div className="branches-list-item">
        <Octicon className="icon" symbol={icon} />
        <div className="name" title={name}>
          <HighlightText text={name} highlight={this.props.matches.title} />
        </div>
        <div className="description" title={infoTitle} />
      </div>
    )
  }
}
