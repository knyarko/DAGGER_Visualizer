/**
 * The one symbol the Visualizer shell imports. Keeping the surface to a single
 * default export is what keeps the edit to the shell as small as it is.
 */

import GraphChatBoundary from './GraphChatBoundary';
import GraphChatViewInner, { type GraphChatViewProps } from './GraphChatView';

/** The shell imports this name, so the boundary wraps the view without the
 *  shell's call site changing. A throw below shows an error WITH the way out,
 *  instead of unmounting the tree to a blank page. */
export function GraphChatView(props: GraphChatViewProps) {
  return (
    <GraphChatBoundary onBack={props.onBack}>
      <GraphChatViewInner {...props} />
    </GraphChatBoundary>
  );
}
export type { GraphChatViewProps } from './GraphChatView';
