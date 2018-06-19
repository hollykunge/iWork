import * as React from 'react'
import { ToolbarButton } from './button'
interface ICreateTableButtonProps {}

export class CreateTableButton extends React.Component<
  ICreateTableButtonProps,
  {}
> {
  public render() {
    return (
      <ToolbarButton className="create-table-button">
        {this.renderAheadBehind()}
      </ToolbarButton>
    )
  }

  private renderAheadBehind() {
    const content: JSX.Element[] = []
    return <div className="ahead-behind">{content}</div>
  }
}
