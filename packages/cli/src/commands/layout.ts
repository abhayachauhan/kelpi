/**
 * `kelpi layout cycle|select <name>` (cli.md §12). Fire-and-forget, caller-pane scoped.
 *
 * Note the order: `requirePaneID()` runs BEFORE the action is validated, so
 * `kelpi layout nonsense` outside a Kelpi pane exits 0 silently rather than reporting the typo.
 * That is the shipped behavior and it is kept. Help is the one exception: it needs no pane, so
 * `--help` / `-h` prints anywhere, and never cycles or selects.
 */

import { hasHelpFlag, isHelpToken } from '../args.js';
import { errLine, exit, writeOut } from '../io.js';
import { requirePaneID } from '../env.js';
import { sendJSON } from '../transport.js';
import { layoutCycleUsage, layoutSelectUsage, layoutUsage } from '../usage.js';

export async function handleLayout(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        errLine('Usage: kelpi layout cycle|select <name>');
        exit(1);
    }
    // Help needs no pane, so it comes before the pane check.
    if (isHelpToken(action)) {
        writeOut(layoutUsage);
        exit(0);
    }
    if (action === 'cycle' && hasHelpFlag(args)) {
        writeOut(layoutCycleUsage);
        exit(0);
    }
    if (action === 'select' && hasHelpFlag(args)) {
        writeOut(layoutSelectUsage);
        exit(0);
    }

    const paneID = requirePaneID();

    if (action === 'cycle') {
        await sendJSON({ command: 'layout-cycle', pane_id: paneID });
        return;
    }
    if (action === 'select') {
        const name = args.shift();
        if (name === undefined) {
            errLine('Usage: kelpi layout select <name>');
            errLine('Valid layouts: even-horizontal, even-vertical, main-horizontal, main-vertical, tiled');
            exit(1);
        }
        // No client-side validation of the layout name — the server owns the vocabulary.
        await sendJSON({ command: 'layout-select', pane_id: paneID, name });
        return;
    }
    errLine(`Unknown layout action: ${action}`);
    errLine('Valid actions: cycle, select');
    exit(1);
}
