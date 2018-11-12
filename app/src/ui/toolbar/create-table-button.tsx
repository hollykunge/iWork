import * as React from 'react'
import { Dispatcher } from '../../lib/dispatcher'
import { ToolbarDropdown, DropdownState } from './dropdown'
import { OcticonSymbol } from '../octicons'
import { IRepositoryState } from '../../lib/app-state'
import { ItemsTab } from '../../models/items-tab'
import { ItemsContainer } from '../branches'

interface ICreateTableButtonProps {
  readonly dispatcher: Dispatcher

  /** AppState中的当前任务包状态 */
  readonly repositoryState: IRepositoryState

  /** 当前选择的选项是否已经打开 */
  readonly isOpen: boolean

  /**
   *
   * 下拉被打开时的处理状态
   *
   * @param state    - 下拉框的新状态
   */
  readonly onDropDownStateChanged: (state: DropdownState) => void

  /** 当前的选择项 */
  readonly selectedTab: ItemsTab
}
export class CreateTableButton extends React.Component<
  ICreateTableButtonProps,
  {}
> {
  private renderBranchFoldout = (): JSX.Element | null => {
    return (
      <ItemsContainer
        dispatcher={this.props.dispatcher}
        selectedTab={this.props.selectedTab}
      />
    )
  }
  private onDropDownStateChanged = (state: DropdownState) => {
    // 执行过程中不允许打开下拉框
    if (state === 'open' && this.props.repositoryState.checkoutProgress) {
      return
    }

    this.props.onDropDownStateChanged(state)
  }

  private getIcon(): OcticonSymbol {
    return OcticonSymbol.note
  }

  public render() {
    let canOpen = true
    let iconClassName: string | undefined = undefined
    let description = __DARWIN__ ? '当前分支任务' : '当前分支任务'
    iconClassName = 'spin'
    const isOpen = this.props.isOpen
    const currentState: DropdownState = isOpen && canOpen ? 'open' : 'closed'

    return (
      <ToolbarDropdown
        className="create-table-button"
        icon={this.getIcon()}
        iconClassName={iconClassName}
        title="{title}"
        description={description}
        tooltip="{tooltip}"
        onDropdownStateChanged={this.onDropDownStateChanged}
        dropdownContentRenderer={this.renderBranchFoldout}
        dropdownState={currentState}
        showDisclosureArrow={canOpen}
      />
    )
  }

  // private renderAheadBehind() {
  //   const content: JSX.Element[] = []
  //   return <div className="ahead-behind">{content}</div>
  // }
}
