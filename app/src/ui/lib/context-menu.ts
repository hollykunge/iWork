const RestrictedFileExtensions = ['.cmd', '.exe', '.bat', '.sh']
export const DefaultEditorLabel = __DARWIN__
  ? 'Open in External Editor'
  : 'Open in external editor'

export const RevealInFileManagerLabel = __DARWIN__
  ? 'Reveal in Finder'
  : __WIN32__
    ? '在资源管理器中显示'
    : '在文件管理器中显示'

export const OpenWithDefaultProgramLabel = __DARWIN__
  ? '使用默认程序打开'
  : '使用默认程序打开'

export function isSafeFileExtension(extension: string): boolean {
  if (__WIN32__) {
    return RestrictedFileExtensions.indexOf(extension.toLowerCase()) === -1
  }
  return true
}
