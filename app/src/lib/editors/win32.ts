import * as Path from 'path'

import {
  enumerateValues,
  HKEY,
  RegistryValue,
  RegistryValueType,
} from 'registry-js'

import { pathExists } from 'fs-extra'
import { IFoundEditor } from './found-editor'

import { assertNever } from '../fatal-error'

export enum ExternalEditor {
  Atom = 'Atom',
  VisualStudioCode = 'Visual Studio Code',
  VisualStudioCodeInsiders = 'Visual Studio Code (Insiders)',
  SublimeText = 'Sublime Text',
  CFBuilder = 'ColdFusion Builder',
}

export function parse(label: string): ExternalEditor | null {
  if (label === ExternalEditor.Atom) {
    return ExternalEditor.Atom
  }
  if (label === ExternalEditor.VisualStudioCode) {
    return ExternalEditor.VisualStudioCode
  }
  if (label === ExternalEditor.VisualStudioCodeInsiders) {
    return ExternalEditor.VisualStudioCodeInsiders
  }
  if (label === ExternalEditor.SublimeText) {
    return ExternalEditor.SublimeText
  }
  if (label === ExternalEditor.CFBuilder) {
    return ExternalEditor.CFBuilder
  }

  return null
}

/**
 * Resolve a set of registry keys associated with the installed application.
 *
 * This is because some tools (like VSCode) may support a 64-bit or 32-bit
 * version of the tool - we should use whichever they have installed.
 *
 * @param editor The external editor that may be installed locally.
 */
function getRegistryKeys(
  editor: ExternalEditor
): ReadonlyArray<{ key: HKEY; subKey: string }> {
  switch (editor) {
    case ExternalEditor.Atom:
      return [
        {
          key: HKEY.HKEY_CURRENT_USER,
          subKey:
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\atom',
        },
      ]
    case ExternalEditor.VisualStudioCode:
      return [
        // 64-bit version of VSCode - not available from home page but just made available
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{EA457B21-F73E-494C-ACAB-524FDE069978}_is1',
        },
        // 32-bit version of VSCode - what most people will be using for the forseeable future
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F8A2A208-72B3-4D61-95FC-8A65D340689B}_is1',
        },
      ]
    case ExternalEditor.VisualStudioCodeInsiders:
      return [
        // 64-bit version of VSCode - not available from home page but just made available
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{1287CAD5-7C8D-410D-88B9-0D1EE4A83FF2}_is1',
        },
        // 32-bit version of VSCode - what most people will be using for the forseeable future
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C26E74D1-022E-4238-8B9D-1E7564A36CC9}_is1',
        },
      ]
    case ExternalEditor.SublimeText:
      return [
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Sublime Text 3_is1',
        },
      ]
    case ExternalEditor.CFBuilder:
      return [
        //64-bit version of ColdFusionBuilder3
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Adobe ColdFusion Builder 3_is1',
        },
        //64-bit version of ColdFusionBuilder2016
        {
          key: HKEY.HKEY_LOCAL_MACHINE,
          subKey:
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Adobe ColdFusion Builder 2016',
        },
      ]

    default:
      return assertNever(editor, `Unknown external editor: ${editor}`)
  }
}

/**
 * Resolve the command-line interface for the editor.
 *
 * @param editor The external editor which is installed
 * @param installLocation The known install location of the editor
 */
function getExecutableShim(
  editor: ExternalEditor,
  installLocation: string
): string {
  switch (editor) {
    case ExternalEditor.Atom:
      return Path.join(installLocation, 'bin', 'atom.cmd')
    case ExternalEditor.VisualStudioCode:
      return Path.join(installLocation, 'bin', 'code.cmd')
    case ExternalEditor.VisualStudioCodeInsiders:
      return Path.join(installLocation, 'bin', 'code-insiders.cmd')
    case ExternalEditor.SublimeText:
      return Path.join(installLocation, 'subl.exe')
    case ExternalEditor.CFBuilder:
      return Path.join(installLocation, 'CFBuilder.exe')
    default:
      return assertNever(editor, `Unknown external editor: ${editor}`)
  }
}

/**
 * Confirm the found installation matches the expected identifier details
 *
 * @param editor The external editor
 * @param displayName The display name as listed in the registry
 * @param publisher The publisher who created the installer
 */
function isExpectedInstallation(
  editor: ExternalEditor,
  displayName: string,
  publisher: string
): boolean {
  switch (editor) {
    case ExternalEditor.Atom:
      return displayName === 'Atom' && publisher === 'GitHub Inc.'
    case ExternalEditor.VisualStudioCode:
      return (
        displayName === 'Microsoft Visual Studio Code' &&
        publisher === 'Microsoft Corporation'
      )
    case ExternalEditor.VisualStudioCodeInsiders:
      return (
        displayName === 'Microsoft Visual Studio Code Insiders' &&
        publisher === 'Microsoft Corporation'
      )
    case ExternalEditor.SublimeText:
      return (
        displayName === 'Sublime Text' && publisher === 'Sublime HQ Pty Ltd'
      )
    case ExternalEditor.CFBuilder:
      return (
        (displayName === 'Adobe ColdFusion Builder 3' ||
          displayName === 'Adobe ColdFusion Builder 2016') &&
        publisher === 'Adobe Systems Incorporated'
      )
    default:
      return assertNever(editor, `Unknown external editor: ${editor}`)
  }
}

function getKeyOrEmpty(
  keys: ReadonlyArray<RegistryValue>,
  key: string
): string {
  const entry = keys.find(k => k.name === key)
  return entry && entry.type === RegistryValueType.REG_SZ ? entry.data : ''
}

/**
 * Map the registry information to a list of known installer fields.
 *
 * @param editor The external editor being resolved
 * @param keys The collection of registry key-value pairs
 */
function extractApplicationInformation(
  editor: ExternalEditor,
  keys: ReadonlyArray<RegistryValue>
): { displayName: string; publisher: string; installLocation: string } {
  if (editor === ExternalEditor.Atom) {
    const displayName = getKeyOrEmpty(keys, 'DisplayName')
    const publisher = getKeyOrEmpty(keys, 'Publisher')
    const installLocation = getKeyOrEmpty(keys, 'InstallLocation')
    return { displayName, publisher, installLocation }
  }

  if (
    editor === ExternalEditor.VisualStudioCode ||
    editor === ExternalEditor.VisualStudioCodeInsiders
  ) {
    const displayName = getKeyOrEmpty(keys, 'DisplayName')
    const publisher = getKeyOrEmpty(keys, 'Publisher')
    const installLocation = getKeyOrEmpty(keys, 'InstallLocation')
    return { displayName, publisher, installLocation }
  }

  if (editor === ExternalEditor.SublimeText) {
    let displayName = ''
    let publisher = ''
    let installLocation = ''

    for (const item of keys) {
      // NOTE:
      // Sublime Text appends the build number to the DisplayName value, so for
      // forward-compatibility let's do a simple check for the identifier
      if (
        item.name === 'DisplayName' &&
        item.type === RegistryValueType.REG_SZ &&
        item.data.startsWith('Sublime Text')
      ) {
        displayName = 'Sublime Text'
      } else if (
        item.name === 'Publisher' &&
        item.type === RegistryValueType.REG_SZ
      ) {
        publisher = item.data
      } else if (
        item.name === 'InstallLocation' &&
        item.type === RegistryValueType.REG_SZ
      ) {
        installLocation = item.data
      }
    }

    return { displayName, publisher, installLocation }
  }

  if (editor === ExternalEditor.CFBuilder) {
    const displayName = getKeyOrEmpty(keys, 'DisplayName')
    const publisher = getKeyOrEmpty(keys, 'Publisher')
    const installLocation = getKeyOrEmpty(keys, 'InstallLocation')
    return { displayName, publisher, installLocation }
  }

  return assertNever(editor, `Unknown external editor: ${editor}`)
}

async function findApplication(editor: ExternalEditor): Promise<string | null> {
  const registryKeys = getRegistryKeys(editor)

  let keys: ReadonlyArray<RegistryValue> = []
  for (const { key, subKey } of registryKeys) {
    keys = enumerateValues(key, subKey)
    if (keys.length > 0) {
      break
    }
  }

  if (keys.length === 0) {
    return null
  }

  const {
    displayName,
    publisher,
    installLocation,
  } = extractApplicationInformation(editor, keys)

  if (!isExpectedInstallation(editor, displayName, publisher)) {
    log.debug(
      `Registry entry for ${editor} did not match expected publisher settings`
    )
    return null
  }

  const path = getExecutableShim(editor, installLocation)
  const exists = await pathExists(path)
  if (!exists) {
    log.debug(`Command line interface for ${editor} not found at '${path}'`)
    return null
  }

  return path
}

/**
 * Lookup known external editors using the Windows registry to find installed
 * applications and their location on disk for Desktop to launch.
 */
export async function getAvailableEditors(): Promise<
  ReadonlyArray<IFoundEditor<ExternalEditor>>
> {
  const results: Array<IFoundEditor<ExternalEditor>> = []

  const [
    atomPath,
    codePath,
    codeInsidersPath,
    sublimePath,
    cfBuilderPath,
  ] = await Promise.all([
    findApplication(ExternalEditor.Atom),
    findApplication(ExternalEditor.VisualStudioCode),
    findApplication(ExternalEditor.VisualStudioCodeInsiders),
    findApplication(ExternalEditor.SublimeText),
    findApplication(ExternalEditor.CFBuilder),
  ])

  if (atomPath) {
    results.push({
      editor: ExternalEditor.Atom,
      path: atomPath,
    })
  }

  if (codePath) {
    results.push({
      editor: ExternalEditor.VisualStudioCode,
      path: codePath,
    })
  }

  if (codeInsidersPath) {
    results.push({
      editor: ExternalEditor.VisualStudioCodeInsiders,
      path: codeInsidersPath,
    })
  }

  if (sublimePath) {
    results.push({
      editor: ExternalEditor.SublimeText,
      path: sublimePath,
    })
  }

  if (cfBuilderPath) {
    results.push({
      editor: ExternalEditor.CFBuilder,
      path: cfBuilderPath,
    })
  }

  return results
}
