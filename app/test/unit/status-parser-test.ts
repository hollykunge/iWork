import { expect } from 'chai'

import {
  parsePorcelainStatus,
  IStatusEntry,
  IStatusHeader,
} from '../../src/lib/status-parser'

describe('parsePorcelainStatus', () => {
  it('parses a standard status', () => {
    const entries = parsePorcelainStatus(
      [
        '1 .D N... 100644 100644 000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 deleted',
        '1 .M N... 100644 100644 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 modified',
        '? untracked',
      ].join('\0') + '\0'
    ) as ReadonlyArray<IStatusEntry>

    expect(entries.length).to.equal(3)

    let i = 0
    expect(entries[i].statusCode).to.equal('.D')
    expect(entries[i].path).to.equal('deleted')
    i++

    expect(entries[i].statusCode).to.equal('.M')
    expect(entries[i].path).to.equal('modified')
    i++

    expect(entries[i].statusCode).to.equal('??')
    expect(entries[i].path).to.equal('untracked')
  })

  it('parses renames', () => {
    const entries = parsePorcelainStatus(
      [
        '2 R. N... 100644 100644 100644 2de0487c2d3e977f5f560b746833f9d7f9a054fd 2de0487c2d3e977f5f560b746833f9d7f9a054fd R100 new\0old',
        '2 RM N... 100644 100644 100644 a3cba7afce66ef37a228e094273c27141db21f36 a3cba7afce66ef37a228e094273c27141db21f36 R100 to\0from',
      ].join('\0') + '\0'
    ) as ReadonlyArray<IStatusEntry>

    expect(entries.length).to.equal(2)

    let i = 0

    expect(entries[i].statusCode).to.equal('R.')
    expect(entries[i].path).to.equal('new')
    expect(entries[i].oldPath).to.equal('old')
    i++

    expect(entries[i].statusCode).to.equal('RM')
    expect(entries[i].path).to.equal('to')
    expect(entries[i].oldPath).to.equal('from')
  })

  it('ignores ignored files', () => {
    // We don't run status with --ignored so this shouldn't be a problem
    // but we test it all the same

    const entries = parsePorcelainStatus(
      ['! foo'].join('\0') + '\0'
    ) as ReadonlyArray<IStatusEntry>

    expect(entries.length).to.equal(0)
  })

  it('parses status headers', () => {
    // We don't run status with --ignored so this shouldn't be a problem
    // but we test it all the same

    const entries = parsePorcelainStatus(
      [
        '# branch.oid 2de0487c2d3e977f5f560b746833f9d7f9a054fd',
        '# branch.head master',
        '# branch.upstream origin/master',
        '# branch.ab +1 -0',
      ].join('\0') + '\0'
    ) as ReadonlyArray<IStatusHeader>

    expect(entries.length).to.equal(4)

    let i = 0

    expect(entries[i++].value).to.equal(
      'branch.oid 2de0487c2d3e977f5f560b746833f9d7f9a054fd'
    )
    expect(entries[i++].value).to.equal('branch.head master')
    expect(entries[i++].value).to.equal('branch.upstream origin/master')
    expect(entries[i++].value).to.equal('branch.ab +1 -0')
  })

  it('parses a path which includes a newline', () => {
    const x = `1 D. N... 100644 000000 000000 dc9fb24e86f7445720b39dcb39a7fc0e410d9583 0000000000000000000000000000000000000000 ProjectSID/Images.xcassets/iPhone 67/Status Center/Report X68 Y461
      /.DS_Store`
    const entries = parsePorcelainStatus(x) as ReadonlyArray<IStatusEntry>

    expect(entries.length).to.equal(1)

    expect(entries[0].path).to
      .equal(`ProjectSID/Images.xcassets/iPhone 67/Status Center/Report X68 Y461
      /.DS_Store`)
    expect(entries[0].statusCode).to.equal('D.')
  })

  it('parses a typechange', () => {
    const x =
      '1 .T N... 120000 120000 100755 6165716e8b408ad09b51d1a37aa1ef50e7f84376 6165716e8b408ad09b51d1a37aa1ef50e7f84376 pdf_linux-x64/lib/libQt5Core.so.5'
    const entries = parsePorcelainStatus(x) as ReadonlyArray<IStatusEntry>

    expect(entries.length).to.equal(1)

    expect(entries[0].path).to.equal('pdf_linux-x64/lib/libQt5Core.so.5')
    expect(entries[0].statusCode).to.equal('.T')
  })
})
