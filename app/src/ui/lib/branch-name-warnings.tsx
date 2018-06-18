import * as React from 'react'
import { Branch } from '../../models/branch'

import { Row } from './row'
import { Octicon, OcticonSymbol } from '../octicons'
import { Ref } from './ref'

export function renderBranchNameWarning(
  proposedName: string,
  sanitizedName: string
) {
  if (proposedName.length > 0 && /^\s*$/.test(sanitizedName)) {
    return (
      <Row className="warning-helper-text">
        <Octicon symbol={OcticonSymbol.alert} />
        <p>
          <Ref>{proposedName}</Ref> is not a valid branch name.
        </p>
      </Row>
    )
  } else if (proposedName !== sanitizedName) {
    return (
      <Row className="warning-helper-text">
        <Octicon symbol={OcticonSymbol.alert} />
        <p>
          Will be created as <Ref>{sanitizedName}</Ref>.
        </p>
      </Row>
    )
  } else {
    return null
  }
}
export function renderBranchHasRemoteWarning(branch: Branch) {
  if (branch.upstream != null) {
    return (
      <Row className="warning-helper-text">
        <Octicon symbol={OcticonSymbol.alert} />
        <p>
          This branch is tracking <Ref>{branch.upstream}</Ref> and renaming this
          branch will not change the branch name on the remote.
        </p>
      </Row>
    )
  } else {
    return null
  }
}
