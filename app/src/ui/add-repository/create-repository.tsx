import { remote } from 'electron'
import * as React from 'react'
import * as Path from 'path'
import * as FSE from 'fs-extra'

import { Dispatcher } from '../../lib/dispatcher'
import {
  initGitRepository,
  createCommit,
  getStatus,
  getAuthorIdentity,
  isGitRepository,
} from '../../lib/git'
import { sanitizedRepositoryName } from './sanitized-repository-name'
import { TextBox } from '../lib/text-box'
import { ButtonGroup } from '../lib/button-group'
import { Button } from '../lib/button'
import { Row } from '../lib/row'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { writeDefaultReadme } from './write-default-readme'
import { Select } from '../lib/select'
import { writeGitDescription } from '../../lib/git/description'
import { getGitIgnoreNames, writeGitIgnore } from './gitignores'
import { ILicense, getLicenses, writeLicense } from './licenses'
import { writeGitAttributes } from './git-attributes'
import { getDefaultDir, setDefaultDir } from '../lib/default-dir'
import { Dialog, DialogContent, DialogFooter, DialogError } from '../dialog'
import { Octicon, OcticonSymbol } from '../octicons'
import { LinkButton } from '../lib/link-button'
import { PopupType } from '../../lib/app-state'

/** The sentinel value used to indicate no gitignore should be used. */
const NoGitIgnoreValue = 'None'

/** The sentinel value used to indicate no license should be used. */
const NoLicenseValue: ILicense = {
  name: 'None',
  featured: false,
  body: '',
  hidden: false,
}

interface ICreateRepositoryProps {
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void

  /** Prefills path input so user doesn't have to. */
  readonly initialPath?: string
}

interface ICreateRepositoryState {
  readonly path: string
  readonly name: string
  readonly description: string

  /** Is the given path able to be written to? */
  readonly isValidPath: boolean | null

  /** Is the given path already a repository? */
  readonly isRepository: boolean

  /** Should the repository be created with a default README? */
  readonly createWithReadme: boolean

  /** Is the repository currently in the process of being created? */
  readonly creating: boolean

  /** The names for the available gitignores. */
  readonly gitIgnoreNames: ReadonlyArray<string> | null

  /** The gitignore to include in the repository. */
  readonly gitIgnore: string

  /** The available licenses. */
  readonly licenses: ReadonlyArray<ILicense> | null

  /** The license to include in the repository. */
  readonly license: string
}

/** The Create New Repository component. */
export class CreateRepository extends React.Component<
  ICreateRepositoryProps,
  ICreateRepositoryState
> {
  public constructor(props: ICreateRepositoryProps) {
    super(props)

    const path = this.props.initialPath
      ? this.props.initialPath
      : getDefaultDir()

    const name = this.props.initialPath
      ? sanitizedRepositoryName(Path.basename(this.props.initialPath))
      : ''

    this.state = {
      path,
      name,
      description: '',
      createWithReadme: false,
      creating: false,
      gitIgnoreNames: null,
      gitIgnore: NoGitIgnoreValue,
      licenses: null,
      license: NoLicenseValue.name,
      isValidPath: null,
      isRepository: false,
    }
  }

  public async componentDidMount() {
    const gitIgnoreNames = await getGitIgnoreNames()
    this.setState({ gitIgnoreNames })

    const licenses = await getLicenses()
    this.setState({ licenses })

    const isRepository = await isGitRepository(this.state.path)
    this.setState({ isRepository })
  }

  private onPathChanged = async (path: string) => {
    const isRepository = await isGitRepository(path)

    this.setState({ isRepository, path, isValidPath: null })
  }

  private onNameChanged = (name: string) => {
    this.setState({ name })
  }

  private onDescriptionChanged = (description: string) => {
    this.setState({ description })
  }

  private showFilePicker = async () => {
    const directory: string[] | null = remote.dialog.showOpenDialog({
      properties: ['createDirectory', 'openDirectory'],
    })

    if (!directory) {
      return
    }

    const path = directory[0]
    const isRepository = await isGitRepository(path)

    this.setState({ isRepository, path })
  }

  private resolveRepositoryRoot = async (): Promise<string> => {
    const currentPath = this.state.path
    if (this.props.initialPath && this.props.initialPath === currentPath) {
      // if the user provided an initial path and didn't change it, we should
      // validate it is an existing path and use that for the repository
      try {
        await FSE.ensureDir(currentPath)
        return currentPath
      } catch {}
    }

    return Path.join(currentPath, sanitizedRepositoryName(this.state.name))
  }

  private createRepository = async () => {
    const fullPath = await this.resolveRepositoryRoot()

    try {
      await FSE.ensureDir(fullPath)
      this.setState({ isValidPath: true })
    } catch (e) {
      if (e.code === 'EACCES' && e.errno === -13) {
        return this.setState({ isValidPath: false })
      }

      log.error(
        `createRepository: the directory at ${fullPath} is not valid`,
        e
      )
      return this.props.dispatcher.postError(e)
    }

    this.setState({ creating: true })

    try {
      await initGitRepository(fullPath)
    } catch (e) {
      this.setState({ creating: false })
      log.error(
        `createRepository: unable to initialize a Git repository at ${fullPath}`,
        e
      )
      return this.props.dispatcher.postError(e)
    }

    const repositories = await this.props.dispatcher.addRepositories([fullPath])
    if (repositories.length < 1) {
      return
    }

    const repository = repositories[0]

    if (this.state.createWithReadme) {
      try {
        await writeDefaultReadme(fullPath, this.state.name)
      } catch (e) {
        log.error(`createRepository: unable to write README at ${fullPath}`, e)
        this.props.dispatcher.postError(e)
      }
    }

    const gitIgnore = this.state.gitIgnore
    if (gitIgnore !== NoGitIgnoreValue) {
      try {
        await writeGitIgnore(fullPath, gitIgnore)
      } catch (e) {
        log.error(
          `createRepository: unable to write .gitignore file at ${fullPath}`,
          e
        )
        this.props.dispatcher.postError(e)
      }
    }

    const description = this.state.description
    if (description) {
      try {
        await writeGitDescription(fullPath, description)
      } catch (e) {
        log.error(
          `createRepository: unable to write .git/description file at ${fullPath}`,
          e
        )
        this.props.dispatcher.postError(e)
      }
    }

    const licenseName =
      this.state.license === NoLicenseValue.name ? null : this.state.license
    const license = (this.state.licenses || []).find(
      l => l.name === licenseName
    )

    if (license) {
      try {
        const author = await getAuthorIdentity(repository)

        await writeLicense(fullPath, license, {
          fullname: author ? author.name : '',
          email: author ? author.email : '',
          year: new Date().getFullYear().toString(),
          description: '',
          project: this.state.name,
        })
      } catch (e) {
        log.error(`createRepository: unable to write LICENSE at ${fullPath}`, e)
        this.props.dispatcher.postError(e)
      }
    }

    try {
      const gitAttributes = Path.join(fullPath, '.gitattributes')
      const gitAttributesExists = await FSE.pathExists(gitAttributes)
      if (!gitAttributesExists) {
        await writeGitAttributes(fullPath)
      }
    } catch (e) {
      log.error(
        `createRepository: unable to write .gitattributes at ${fullPath}`,
        e
      )
      this.props.dispatcher.postError(e)
    }

    try {
      const status = await getStatus(repository)
      const wd = status.workingDirectory
      const files = wd.files
      if (files.length > 0) {
        await createCommit(repository, 'Initial commit', files)
      }
    } catch (e) {
      log.error(`createRepository: initial commit failed at ${fullPath}`, e)
      this.props.dispatcher.postError(e)
    }

    this.setState({ creating: false })

    this.updateDefaultDirectory()

    this.props.dispatcher.selectRepository(repository)
    this.props.onDismissed()
  }

  private updateDefaultDirectory = () => {
    // don't update the default directory as a result of creating the
    // repository from an empty folder, because this value will be the
    // repository path itself
    if (!this.props.initialPath) {
      setDefaultDir(this.state.path)
    }
  }

  private onCreateWithReadmeChange = (
    event: React.FormEvent<HTMLInputElement>
  ) => {
    this.setState({
      createWithReadme: event.currentTarget.checked,
    })
  }

  private renderSanitizedName() {
    const sanitizedName = sanitizedRepositoryName(this.state.name)
    if (this.state.name === sanitizedName) {
      return null
    }

    return (
      <Row className="warning-helper-text">
        <Octicon symbol={OcticonSymbol.alert} />
        Will be created as {sanitizedName}
      </Row>
    )
  }

  private onGitIgnoreChange = (event: React.FormEvent<HTMLSelectElement>) => {
    const gitIgnore = event.currentTarget.value
    this.setState({ gitIgnore })
  }

  private onLicenseChange = (event: React.FormEvent<HTMLSelectElement>) => {
    const license = event.currentTarget.value
    this.setState({ license })
  }

  private renderGitIgnores() {
    const gitIgnores = this.state.gitIgnoreNames || []
    const options = [NoGitIgnoreValue, ...gitIgnores]

    return (
      <Row>
        <Select
          label={__DARWIN__ ? 'Git Ignore' : 'Git ignore'}
          value={this.state.gitIgnore}
          onChange={this.onGitIgnoreChange}
        >
          {options.map(n => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Row>
    )
  }

  private renderLicenses() {
    const licenses = this.state.licenses || []
    const featuredLicenses = [
      NoLicenseValue,
      ...licenses.filter(l => l.featured),
    ]
    const nonFeaturedLicenses = licenses.filter(l => !l.featured)

    return (
      <Row>
        <Select
          label="License"
          value={this.state.license}
          onChange={this.onLicenseChange}
        >
          {featuredLicenses.map(l => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
          <option disabled={true}>────────────────────</option>
          {nonFeaturedLicenses.map(l => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </Select>
      </Row>
    )
  }

  private renderInvalidPathError() {
    const isValidPath = this.state.isValidPath
    const pathSet = isValidPath !== null

    if (!pathSet || isValidPath) {
      return null
    }

    return (
      <DialogError>
        Directory could not be created at this path. You may not have
        permissions to create a directory here.
      </DialogError>
    )
  }

  private renderGitRepositoryWarning() {
    const isRepo = this.state.isRepository

    if (this.state.path.length && !isRepo) {
      return null
    }

    return (
      <Row className="warning-helper-text">
        <Octicon symbol={OcticonSymbol.alert} />
        <p>
          This directory appears to be a Git repository. Would you like to{' '}
          <LinkButton onClick={this.onAddRepositoryClicked}>
            add this repository
          </LinkButton>{' '}
          instead?
        </p>
      </Row>
    )
  }

  private onAddRepositoryClicked = () => {
    return this.props.dispatcher.showPopup({
      type: PopupType.AddRepository,
      path: this.state.path,
    })
  }

  public render() {
    const disabled =
      this.state.path.length === 0 ||
      this.state.name.length === 0 ||
      this.state.creating ||
      this.state.isRepository

    const readOnlyPath = !!this.props.initialPath

    return (
      <Dialog
        id="create-repository"
        title={__DARWIN__ ? '创建一个新的任务' : '创建一个新的任务'}
        loading={this.state.creating}
        onSubmit={this.createRepository}
        onDismissed={this.props.onDismissed}
      >
        {this.renderInvalidPathError()}

        <DialogContent>
          <Row>
            <TextBox
              value={this.state.name}
              label="名称"
              placeholder="任务名称"
              onValueChanged={this.onNameChanged}
              autoFocus={true}
            />
          </Row>

          {this.renderSanitizedName()}

          <Row>
            <TextBox
              value={this.state.description}
              label="描述"
              onValueChanged={this.onDescriptionChanged}
            />
          </Row>

          <Row>
            <TextBox
              value={this.state.path}
              label={__DARWIN__ ? '本地路径' : '本地路径'}
              placeholder="任务路径"
              onValueChanged={this.onPathChanged}
              disabled={readOnlyPath}
            />
            <Button onClick={this.showFilePicker} disabled={readOnlyPath}>
              选择…
            </Button>
          </Row>

          {this.renderGitRepositoryWarning()}

          <Row>
            <Checkbox
              label="为该任务创建一个描述文件"
              value={
                this.state.createWithReadme
                  ? CheckboxValue.On
                  : CheckboxValue.Off
              }
              onChange={this.onCreateWithReadmeChange}
            />
          </Row>

          {this.renderGitIgnores()}
          {this.renderLicenses()}
        </DialogContent>

        <DialogFooter>
          <ButtonGroup>
            <Button type="submit" disabled={disabled}>
              {__DARWIN__ ? '创建任务' : '创建任务'}
            </Button>

            <Button onClick={this.props.onDismissed}>取消</Button>
          </ButtonGroup>
        </DialogFooter>
      </Dialog>
    )
  }
}
