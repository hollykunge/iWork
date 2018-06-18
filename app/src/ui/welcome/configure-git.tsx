import * as React from 'react'
import { WelcomeStep } from './welcome'
import { Account } from '../../models/account'
import { ConfigureGitUser } from '../lib/configure-git-user'
import { Button } from '../lib/button'

interface IConfigureGitProps {
  readonly accounts: ReadonlyArray<Account>
  readonly advance: (step: WelcomeStep) => void
}

/** The Welcome flow step to configure git. */
export class ConfigureGit extends React.Component<IConfigureGitProps, {}> {
  public render() {
    return (
      <div id="configure-git">
        <h1 className="welcome-title">配置本地数据仓库</h1>
        <p className="welcome-text">
          请确认以下信息，这是用来验证你的提交信息的，在协同工作过程中需要使用以下信息。
        </p>

        <ConfigureGitUser
          accounts={this.props.accounts}
          onSave={this.continue}
          saveLabel="确认"
        >
          <Button onClick={this.cancel}>取消</Button>
        </ConfigureGitUser>
      </div>
    )
  }

  private cancel = () => {
    this.props.advance(WelcomeStep.Start)
  }

  private continue = () => {
    this.props.advance(WelcomeStep.UsageOptOut)
  }
}
