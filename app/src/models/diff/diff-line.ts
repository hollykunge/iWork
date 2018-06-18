/** indicate what a line in the diff represents */
export enum DiffLineType {
  Context,
  Add,
  Delete,
  Hunk,
}

/** track details related to each line in the diff */
export class DiffLine {
  public readonly text: string
  public readonly type: DiffLineType
  public readonly oldLineNumber: number | null
  public readonly newLineNumber: number | null
  public readonly noTrailingNewLine: boolean

  public constructor(
    text: string,
    type: DiffLineType,
    oldLineNumber: number | null,
    newLineNuber: number | null,
    noTrailingNewLine: boolean = false
  ) {
    this.text = text
    this.type = type
    this.oldLineNumber = oldLineNumber
    this.newLineNumber = newLineNuber
    this.noTrailingNewLine = noTrailingNewLine
  }

  public withNoTrailingNewLine(noTrailingNewLine: boolean): DiffLine {
    return new DiffLine(
      this.text,
      this.type,
      this.oldLineNumber,
      this.newLineNumber,
      noTrailingNewLine
    )
  }

  public isIncludeableLine() {
    return this.type === DiffLineType.Add || this.type === DiffLineType.Delete
  }

  /** The content of the line, i.e., without the line type marker. */
  public get content(): string {
    return this.text.substr(1)
  }
}
