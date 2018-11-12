import { Dispatcher } from '../../lib/dispatcher'
import * as React from 'react'
import { TabBar } from '../tab-bar'
import { ItemsTab } from '../../models/items-tab'
interface IItemsContainerProps {
  readonly selectedTab: ItemsTab
  readonly dispatcher: Dispatcher
}

/** The unified Branches and Pull Requests component. */
export class ItemsContainer extends React.Component<IItemsContainerProps> {
  public constructor(props: IItemsContainerProps) {
    super(props)

    this.state = {
      branchFilterText: '',
      pullRequestFilterText: '',
    }
  }

  public render() {
    return (
      <div className="branches-container">
        {this.renderTabBar()}
        {this.renderSelectedTab()}
      </div>
    )
  }

  private renderTabBar() {
    let countElement = null

    return (
      <TabBar
        onTabClicked={this.onTabClicked}
        selectedIndex={this.props.selectedTab}
      >
        <span>Branches</span>
        <span className="pull-request-tab">
          {__DARWIN__ ? 'Pull Requests' : 'Pull requests'}

          {countElement}
        </span>
      </TabBar>
    )
  }

  private renderSelectedTab() {
    // let tab = this.props.selectedTab
  }

  private onTabClicked = (tab: ItemsTab) => {
    this.props.dispatcher.changeItemsTab(tab)
  }
}
