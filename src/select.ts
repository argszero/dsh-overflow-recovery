/**
 * Choose the region a deterministic recovery drops.
 *
 * The selection mirrors the shipped `selectCompactableRange`
 * (`@deepseek-ai/dsh-compaction-basic/src/region.ts`) in the three rules that
 * make a surface cut safe, and it is deliberately narrower than that function:
 *
 * 1. **Never surface node 0.** `assertSystemHeadRewrite`
 *    (`@deepseek-ai/dsh-session/src/surface.ts`) permits a replacement that
 *    covers node 0 only when the replacement is itself a `system/message` over
 *    exactly that node. The system prompt is not ours to rewrite, so the drop
 *    starts at index 1 and the head survives whatever it holds.
 * 2. **Never split a tool-call/tool-result pair.** The cut before the retained
 *    tail must satisfy the shipped `toolPairingBalancedBefore`; an unbalanced
 *    cut would leave an unanswered tool call on the surface, which is the
 *    orphan-`tool/call` shape that wedges a session permanently. One check is
 *    enough: the range's leading cut sits directly after surface node 0, whose
 *    balance holds by construction.
 * 3. **Retain a priced newest tail**, bounded from below by a node count so one
 *    oversized node cannot pull the retained tail back past the current
 *    exchange.
 *
 * Unlike `selectCompactableRange` this never reads a surface event's type: the
 * session's synchronous historical readers are deprecated for new callers
 * (`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`),
 * and the only thing a kind would buy here is the ability to start at node 0,
 * which rule 1 forbids anyway.
 *
 * @module @argszero/dsh-overflow-recovery/select
 */

import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter'
import type { Settings } from './config.ts'

/** One droppable span of current surface positions, with its prices. */
export interface DropRange {
  /** Inclusive first dropped surface-node seq. */
  readonly start: SessionSeq
  /** Inclusive last dropped surface-node seq. */
  readonly end: SessionSeq
  /** Every dropped surface-node seq, in surface order — the exact replacement range. */
  readonly shadowedSeqs: readonly SessionSeq[]
  /** Sum of the dropped nodes' route prices. */
  readonly droppedTokens: number
  /** Sum of the dropped nodes' fixed-heuristic prices — the shadow-price claim. */
  readonly shadowedTokenCount: number
  /** Route price of the retained tail. */
  readonly retainedTokens: number
}

/**
 * Resolve the oldest region that may be dropped, or `null` when no drop is
 * possible.
 *
 * @param session - session whose current surface is cut.
 * @param nodes - the surface nodes in order, as priced by the token meter.
 * @param settings - resolved retention bounds.
 * @returns the droppable range, or `null` when the surface holds nothing this
 *   plugin is allowed to take.
 */
export function selectDropRange(
  session: Session,
  nodes: readonly TokenSurfaceNode[],
  settings: Settings,
): DropRange | null {
  // Rule 1: the system head at node 0 is never inside a range.
  const firstIdx = 1
  if (nodes.length <= firstIdx) return null

  // Rule 3: retain the newest nodes until BOTH budgets are satisfied — the
  // token budget says how much recent context is worth keeping, and the node
  // floor keeps a single oversized node from standing in for the whole tail.
  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= firstIdx; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is bounded by the loop condition.
    accumulated += nodes[index]!.tokens
    keepFromIdx = index
    if (nodes.length - index >= settings.retainMinNodes && accumulated >= settings.retainTokens) break
  }

  // Rule 2: the retained tail may only begin at a balanced cut.
  while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, seqAt(nodes, keepFromIdx))) {
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  const endIdx = keepFromIdx - 1

  const shadowedSeqs: SessionSeq[] = []
  let droppedTokens = 0
  let shadowedTokenCount = 0
  for (let index = firstIdx; index <= endIdx; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is bounded by the loop condition.
    const node = nodes[index]!
    shadowedSeqs.push(node.seq)
    droppedTokens += node.tokens
    shadowedTokenCount += node.heuristicTokens
  }
  return {
    start: seqAt(nodes, firstIdx),
    end: seqAt(nodes, endIdx),
    shadowedSeqs,
    droppedTokens,
    shadowedTokenCount,
    retainedTokens: accumulated,
  }
}

/** The seq at one surface position. */
function seqAt(nodes: readonly TokenSurfaceNode[], index: number): SessionSeq {
  // oxlint-disable-next-line typescript/no-non-null-assertion -- callers pass in-range positions.
  return nodes[index]!.seq
}
