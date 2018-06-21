import * as React from 'react'
import { ToolbarButton } from './button'
import { OcticonSymbol } from '../octicons'

export class CreateTableButton extends React.Component {
  private getIcon(): OcticonSymbol {
    return OcticonSymbol.note
  }

  public render() {
    return (
      <ToolbarButton
        title={'新建表单'}
        className="create-table-button"
        icon={this.getIcon()}
      />
    )
  }

  // private renderAheadBehind() {
  //   const content: JSX.Element[] = []
  //   return <div className="ahead-behind">{content}</div>
  // }
}
