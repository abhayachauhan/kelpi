/**
 * `kelpi pane run-suggested` (cli.md §9.12.1): find the last shell command Claude Code suggested in a
 * pane capture and undo the line wraps Claude Code drew itself (a real newline plus the block's
 * indent and two more spaces). Everything here is pure; the command in commands/pane.ts does the I/O.
 */

export type SuggestedKind = 'bang' | 'fence';

export interface Suggested {
    readonly command: string;
    readonly kind: SuggestedKind;
}

/** Lines of scrollback the command reads from the pane. */
export const SUGGESTED_CAPTURE_LINES = 200;

const width = (line: string): number => [...line].length;
const lead = (line: string): number => line.length - line.trimStart().length;
// Claude Code draws its input box with full-width rules; their length is the pane width.
const RULE = /^\s*[─━═╌┄]{20,}\s*$/;
const BANG = /^(\s*(?:[⏺●]\s+)?)! (\S.*)$/;
const FENCE_OPEN = /^(\s*)```\s*(?:bash|sh|shell|zsh)?\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const USER_PROMPT = /^[>❯] /;
// A tool's output starts at `⎿` and runs while its lines sit right of it.
const OUTPUT = /^\s*⎿/;
const lastToken = (line: string): string => line.trimEnd().split(/\s+/).at(-1) ?? '';
const firstToken = (line: string): string => line.trim().split(/\s+/)[0] ?? '';
const at = (lines: readonly string[], index: number): string => lines[index] ?? '';

/** The pane width the capture shows (its widest rule line), or 0 when there is none. */
export function wrapWidth(lines: readonly string[]): number {
    return lines.filter((line) => RULE.test(line)).reduce((max, line) => Math.max(max, width(line.trimEnd())), 0);
}

/**
 * Rejoin a block's lines. A line indented by exactly `indent + 2` continues the line before it
 * (unless that one ends with a shell `\`); any other line starts a new command. The break was at a
 * space unless the line before filled the wrap width without a trailing space, which means the wrap
 * split a token (join with nothing). Unknown width (0) never counts as filled.
 */
export function joinWraps(lines: readonly string[], indent: number, wrap = 0): string {
    const commands: string[] = [];
    let previous: string | null = null;
    for (const line of lines) {
        if (!line.trim()) {
            previous = null;
            continue;
        }
        const current = commands.at(-1);
        if (previous !== null && current !== undefined && lead(line) === indent + 2 && !current.trimEnd().endsWith('\\')) {
            // Claude Code splits only a word too long for the line, so a filled line is a mid-token
            // break only when the two halves together are a long word.
            const filled = wrap > 0 && width(previous) >= wrap - 1 && width(lastToken(previous) + firstToken(line)) > wrap / 2;
            const separator = !previous.endsWith(' ') && filled ? '' : ' ';
            commands[commands.length - 1] = current.trimEnd() + separator + line.trim();
        } else {
            commands.push(line.slice(Math.min(lead(line), indent)).trimEnd());
        }
        previous = line;
    }
    return commands.join('\n');
}

// A rule, or the `⎿` Claude Code puts under a command's output, never continues a command.
const ends = (line: string): boolean => !line.trim() || RULE.test(line) || line.trimStart().startsWith('⎿');

/**
 * Lines after `from` that continue a `! ` command at `indent`. Claude Code wraps them under the text
 * after `! ` (indent + 2) or, in reply text, back at the `!` column; another `! ` line or a fence there
 * starts a new block.
 */
function bangContinuation(lines: readonly string[], from: number, indent: number): number {
    let end = from + 1;
    for (; end < lines.length; end += 1) {
        const line = at(lines, end);
        if (ends(line)) break;
        const wraps = lead(line) === indent + 2 || (lead(line) === indent && !BANG.test(line) && !FENCE_OPEN.test(line));
        if (!wraps) break;
    }
    return end;
}

/** Wrapped lines drawn at the block's own column, re-indented by two so joinWraps sees them as wraps. */
const reindent = (lines: readonly string[], indent: number): string[] =>
    lines.map((line) => (lead(line) === indent ? `  ${line}` : line));

/** Every suggested command in the capture, in order. */
function candidates(lines: readonly string[], wrap: number): Suggested[] {
    const found: Suggested[] = [];
    // The `⎿` column while inside a tool's output, which Claude did not write, else null.
    let output: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
        const line = at(lines, i);
        if (OUTPUT.test(line)) {
            output = lead(line);
            continue;
        }
        if (output !== null) {
            // Claude's own `⏺` bullets and rules sit left of `⎿`; ones drawn deeper are the tool's text.
            if (!line.trim() || lead(line) > output) continue;
            output = null;
        }
        if (USER_PROMPT.test(line)) continue; // the user's own message, echoed into the transcript
        const bang = BANG.exec(line);
        if (bang) {
            // The block's indent is the column of `!`; `! ` becomes two spaces so the width check
            // still sees the line as wide as it was drawn.
            const indent = width(bang[1] ?? '');
            const end = bangContinuation(lines, i, indent);
            const block = [' '.repeat(indent + 2) + (bang[2] ?? ''), ...reindent(lines.slice(i + 1, end), indent)];
            // Output under it (`⎿`) means this is a `!` command the user already ran, not a suggestion.
            const ran = at(lines, end).trimStart().startsWith('⎿');
            if (!ran) found.push({ kind: 'bang', command: joinWraps(block, indent, wrap).trim() });
            i = end - 1;
            continue;
        }
        if (FENCE_OPEN.test(line)) {
            let close = i + 1;
            while (close < lines.length && !FENCE_CLOSE.test(at(lines, close))) close += 1;
            if (close >= lines.length) break; // still being written
            const body = lines.slice(i + 1, close);
            // Another fence inside means this ``` closed a block that began above the capture.
            if (body.some((l) => /^\s*```/.test(l))) continue;
            const filled = body.filter((l) => l.trim());
            if (filled.length) found.push({ kind: 'fence', command: joinWraps(body, Math.min(...filled.map(lead)), wrap) });
            i = close;
            continue;
        }
        // A `! cmd` inside a sentence is not offered: plain screen text can't tell where the command ends.
    }
    return found;
}

/** The last command Claude Code suggested in `capture`, rejoined, or null. */
export function findSuggested(capture: string): Suggested | null {
    const all = capture.replace(/\r/g, '').split('\n');
    // Read only the transcript above Claude Code's input box, so a draft in the box is never the suggestion.
    const rules = all.flatMap((line, index) => (BOX_RULE.test(line) ? [index] : []));
    const lines = rules.length >= 2 ? all.slice(0, rules.at(-2)) : all;
    return candidates(lines, wrapWidth(all)).filter((c) => c.command.trim()).at(-1) ?? null;
}

// Tab, ESC, CR and the rest: anything that could act as a keystroke instead of text.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Why `command` may not be typed into a pane, or null. */
export function commandProblem(command: string): string | null {
    if (!command.trim()) return 'the command is empty';
    // Invisible format characters (bidi overrides, zero-width) could make the text shown differ from what runs.
    if (/\p{Cf}/u.test(command)) return 'the command contains an invisible formatting character';
    if (/[\p{Zl}\p{Zp}]/u.test(command)) return 'the command contains a Unicode line or paragraph separator';
    if (/[\p{Mn}\p{Me}]/u.test(command)) return 'the command contains a combining mark';
    if (/[^\P{Zs} ]/u.test(command)) return 'the command contains a space other than a plain space';
    if (CONTROL.test(command)) return 'the command contains a control character';
    return null;
}

/** The fields of a `pane-list` entry the routing decision reads. */
export interface SourcePane {
    readonly agent?: string | undefined;
    readonly agent_session_id?: string | undefined;
    readonly status?: string | undefined;
}

// The input box's own rules start at column 0; rules inside reply text or tool output are indented.
const BOX_RULE = /^[─━═]{20,}\s*$/;
const PROMPT_EMPTY = /^[>❯]\s*$/;
const MENU = /[>❯]\s*\d+\.|Do you want|Esc to cancel/;
// A finished reply and a permission prompt are both waitingForInput; the screen tells them apart.
const READY_STATUSES = new Set(['idle', 'waitingForInput']);

/**
 * True when the capture ends with Claude Code's input box empty: a bare `>` prompt between its two
 * rules, and no menu below it. A permission prompt or a half-typed draft replaces the bare prompt,
 * and typing there would answer it.
 */
export function promptReady(capture: string): boolean {
    const lines = capture.replace(/\r/g, '').split('\n');
    const rules = lines.flatMap((line, index) => (BOX_RULE.test(line) ? [index] : []));
    const below = rules.at(-1);
    const above = rules.at(-2);
    if (below === undefined || above !== below - 2 || !PROMPT_EMPTY.test(at(lines, below - 1))) return false;
    return !lines.slice(below + 1).some((line) => MENU.test(line));
}

/**
 * True when the command should be typed into the Claude session it came from: Claude wrote it with
 * `!` (meant for the user to run there), it is one line, and the pane is a live Claude session that
 * is not mid-reply and shows its empty input box. Anything else runs in a new shell pane.
 * A trailing `\` counts as more than one line: with Enter after it, Claude's box starts a new line.
 */
export function runsInSession(found: Suggested, pane: SourcePane, capture: string): boolean {
    const bang = found.kind === 'bang';
    const oneLine = !found.command.includes('\n') && !found.command.trimEnd().endsWith('\\');
    const live = pane.agent === 'claude' && !!pane.agent_session_id && READY_STATUSES.has(pane.status ?? '');
    return bang && oneLine && live && promptReady(capture);
}
