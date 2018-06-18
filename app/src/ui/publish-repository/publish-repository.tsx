import * as React from 'react'
import { Account } from '../../models/account'
import { API, IAPIUser } from '../../lib/api'
import { TextBox } from '../lib/text-box'
import { Select } from '../lib/select'
import { DialogContent } from '../dialog'
import { Row } from '../lib/row'
import { merge } from '../../lib/merge'
import { caseInsensitiveCompare } from '../../lib/compare'

interface IPublishRepositoryProps {
  /** The user to use for publishing. */
  readonly account: Account

  /** The settings to use when publishing the repository. */
  readonly settings: IPublishRepositorySettings

  /** The function called when any of the publish settings are changed. */
  readonly onSettingsChanged: (settings: IPublishRepositorySettings) => void
}

export interface IPublishRepositorySettings {
  /** The name to use when publishing the repository. */
  readonly name: string

  /** The repository's description. */
  readonly description: string

  /** Should the repository be private? */
  readonly private: boolean

  /**
   * The org to which this repository belongs. If null, the repository should be
   * published as a personal repository.
   */
  readonly org: IAPIUser | null
}

interface IPublishRepositoryState {
  readonly orgs: ReadonlyArray<IAPIUser>
}

/** The Publish Repository component. */
export class PublishRepository extends React.Component<
  IPublishRepositoryProps,
  IPublishRepositoryState
> {
  public constructor(props: IPublishRepositoryProps) {
    super(props)

    this.state = { orgs: [] }
  }

  public async componentWillMount() {
    this.fetchOrgs(this.props.account)
  }

  public componentWillReceiveProps(nextProps: IPublishRepositoryProps) {
    if (this.props.account !== nextProps.account) {
      this.setState({ orgs: [] })

      this.fetchOrgs(nextProps.account)
    }
  }

  private async fetchOrgs(account: Account) {
    const api = API.fromAccount(account)
    const orgs = (await api.fetchOrgs()) as Array<IAPIUser>
    orgs.sort((a, b) => caseInsensitiveCompare(a.login, b.login))
    this.setState({ orgs })
  }

  private updateSettings<K extends keyof IPublishRepositorySettings>(
    subset: Pick<IPublishRepositorySettings, K>
  ) {
    const existingSettings = this.props.settings
    const newSettings = merge(existingSettings, subset)
    this.props.onSettingsChanged(newSettings)
  }

  private onNameChange = (name: string) => {
    this.updateSettings({ name })
  }

  private onDescriptionChange = (description: string) => {
    this.updateSettings({ description })
  }

  private onPrivateChange = (event: React.FormEvent<HTMLInputElement>) => {
    this.updateSettings({ private: event.currentTarget.checked })
  }

  private onOrgChange = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    const index = parseInt(value, 10)
    if (index < 0 || isNaN(index)) {
      this.updateSettings({ org: null })
    } else {
      const org = this.state.orgs[index]
      this.updateSettings({ org })
    }
  }

  private renderOrgs(): JSX.Element | null {
    if (this.state.orgs.length === 0) {
      return null
    }

    const options = new Array<JSX.Element>()
    options.push(
      <option value={-1} key={-1}>
        None
      </option>
    )

    let selectedIndex = -1
    const selectedOrg = this.props.settings.org
    for (const [index, org] of this.state.orgs.entries()) {
      if (selectedOrg && selectedOrg.id === org.id) {
        selectedIndex = index
      }

      options.push(
        <option value={index} key={index}>
          {org.login}
        </option>
      )
    }

    return (
      <Select
        label="Organization"
        value={selectedIndex.toString()}
        onChange={this.onOrgChange}
      >
        {options}
      </Select>
    )
  }

  public render() {
    return (
      <DialogContent>
        <Row>
          <TextBox
            label="Name"
            value={this.props.settings.name}
            autoFocus={true}
            onValueChanged={this.onNameChange}
          />
        </Row>

        <Row>
          <TextBox
            label="Description"
            value={this.props.settings.description}
            onValueChanged={this.onDescriptionChange}
          />
        </Row>

        <Row>
          <label>
            <input
              type="checkbox"
              checked={this.props.settings.private}
              onChange={this.onPrivateChange}
            />
            Keep this code private
          </label>
        </Row>

        {this.renderOrgs()}
      </DialogContent>
    )
  }
}
