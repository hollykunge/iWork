import * as React from 'react'
import { WelcomeStep } from './welcome'
import { LinkButton } from '../lib/link-button'

const CreateAccountURL = 'https://github.com/join?source=github-desktop'

interface IStartProps {
  readonly advance: (step: WelcomeStep) => void
}

/** The first step of the Welcome flow. */
export class Start extends React.Component<IStartProps, {}> {
  public render() {
    return (
      <div id="start">
        <h1 className="welcome-title">欢迎</h1>
        <p className="welcome-text">
          iWork是基于WorkHub的本地数据管理工具，可通过iWork进行本地数据协同管理和数据离线管理。
        </p>

        <p className="welcome-text">
          不了解WorkHub?{' '}
          <LinkButton uri={CreateAccountURL}>访问WorkHub</LinkButton>
        </p>

        <hr className="short-rule" />

        <div>
          <LinkButton className="welcome-button" onClick={this.signInToDotCom}>
            通过WorkHub中的身份登录
          </LinkButton>
        </div>

        {/* <div>
          <LinkButton
            className="welcome-button"
            onClick={this.signInToEnterprise}
          >
            Sign into GitHub Enterprise
          </LinkButton>
        </div> */}

        <div className="skip-action-container">
          <LinkButton className="skip-button" onClick={this.skip}>
            跳过这一步
          </LinkButton>
        </div>
      </div>
    )
  }

  private signInToDotCom = () => {
    this.props.advance(WelcomeStep.SignInToDotCom)
  }

  // private signInToEnterprise = () => {
  //   this.props.advance(WelcomeStep.SignInToEnterprise)
  // }

  private skip = () => {
    this.props.advance(WelcomeStep.ConfigureGit)
  }
}
