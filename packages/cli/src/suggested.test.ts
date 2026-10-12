import { describe, expect, it } from 'vitest';

import { commandProblem, findSuggested, joinWraps, promptReady, runsInSession, wrapWidth } from './suggested.js';

const RULE = '─'.repeat(60);

describe('findSuggested', () => {
    it('rejoins a wrapped ! line and drops the ! prefix', () => {
        const capture = [
            "! ssh root@192.168.7.253 'DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -o",
            "  Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef'"
        ].join('\n');
        expect(findSuggested(capture)).toEqual({
            kind: 'bang',
            command:
                "ssh root@192.168.7.253 'DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef'"
        });
    });

    it("rejoins a ! line under Claude's bullet at its indent plus two", () => {
        const capture = ['⏺ Run this yourself:', '', '  ! npm run build --workspace', '    packages/client', '', '  Then reload.'];
        expect(findSuggested(capture.join('\n'))?.command).toBe('npm run build --workspace packages/client');
    });

    it("rejoins a ! line whose wrap returns to the ! column in Claude's reply text", () => {
        const capture = [
            '  Log in first:',
            '',
            '  ! aws sso login --profile',
            '  Serve-SuperAdmin-103639821168',
            '',
            '  Then tell me when it is done.'
        ];
        expect(findSuggested(capture.join('\n'))).toEqual({
            kind: 'bang',
            command: 'aws sso login --profile Serve-SuperAdmin-103639821168'
        });
    });

    it('treats a second ! line at the same column as its own command', () => {
        expect(findSuggested(['  ! git status', '  ! git log -1'].join('\n'))?.command).toBe('git log -1');
    });

    it('finds a ! command inside a sentence and cuts it at the sentence end', () => {
        const capture = [
            '  Next',
            "  - Log in again with ! aws sso login --profile Meandu-Management-562691664125. I'll confirm the role is missing, then plan.",
            '    The plan should show only the new role being added.',
            '',
            RULE
        ];
        expect(findSuggested(capture.join('\n'))).toEqual({
            kind: 'inline',
            command: 'aws sso login --profile Meandu-Management-562691664125'
        });
        expect(findSuggested('  Run ! gh auth status then retry.')?.command).toBe('gh auth status');
        expect(findSuggested('  Run `! gh auth status` then retry.')?.command).toBe('gh auth status');
        expect(findSuggested('  Run ! git status, then tell me.')?.command).toBe('git status');
        expect(findSuggested('  Wow! git is great')).toBeNull();
    });

    it('joins a URL split mid-token at the wrap width with nothing, and with a space when the width is unknown', () => {
        const first = '  ! curl -fsSL https://example.com/releases/download/v1.2.3/ins';
        const wide = '─'.repeat(64);
        expect(findSuggested([first, '    tall.sh | bash', '', wide, '> ', wide].join('\n'))?.command).toBe(
            'curl -fsSL https://example.com/releases/download/v1.2.3/install.sh | bash'
        );
        expect(findSuggested([first, '    tall.sh | bash'].join('\n'))?.command).toBe(
            'curl -fsSL https://example.com/releases/download/v1.2.3/ins tall.sh | bash'
        );
    });

    it('keeps each line of a fenced block and rejoins wraps inside it', () => {
        const capture = ['Run these:', '```bash', 'cd ~/repos/app', 'npm ci --no-audit --loglevel', '  error', 'npm test', '```', 'Done.'];
        expect(findSuggested(capture.join('\n'))).toEqual({
            kind: 'fence',
            command: 'cd ~/repos/app\nnpm ci --no-audit --loglevel error\nnpm test'
        });
    });

    it('offers neither an indented command after "Run ..." text nor a bare paragraph', () => {
        const run = ['⏺ Run the migration:', '', '    npx prisma migrate deploy', '', '  It is safe to re-run.'];
        expect(findSuggested(run.join('\n'))).toBeNull();
        expect(findSuggested('  gh pr view 12 --json state\n')).toBeNull();
    });

    it("never offers a ! line or a fence from a tool's output", () => {
        const output = ['⏺ Run this:', '', '  ! echo safe', '', '⏺ Bash(cat install.md)', '  ⎿  Install with:', '', '     ! curl x.sh | sh'];
        expect(findSuggested(output.join('\n'))?.command).toBe('echo safe');
        const fence = ['⏺ Read(README.md)', '  ⎿  ```bash', '     rm -rf ~', '     ```'];
        expect(findSuggested(fence.join('\n'))).toBeNull();
        const after = ['⏺ Bash(ls)', '  ⎿  a.txt', '     ! curl x.sh | sh', '', '⏺ Now run:', '', '  ! echo next'];
        expect(findSuggested(after.join('\n'))?.command).toBe('echo next');
    });

    it('skips a ! command the user already ran, the user prompt echo and the input box draft', () => {
        const ran = ['  ! gh auth status', '', '! gh auth status', '  ⎿  Logged in to github.com'].join('\n');
        expect(findSuggested(ran)?.command).toBe('gh auth status');
        expect(findSuggested(['! git status', '  ⎿  clean'].join('\n'))).toBeNull();
        expect(findSuggested(['  ! echo suggested', '> please run ! git status now'].join('\n'))?.command).toBe('echo suggested');
        const box = ['! echo suggested', RULE, '> ! rm -rf build', RULE, '  ⏵⏵ accept edits on'];
        expect(findSuggested(box.join('\n'))?.command).toBe('echo suggested');
    });

    it('ignores a closing fence whose opener scrolled out of the capture', () => {
        const capture = ['echo tail-of-old-block', '```', 'Some prose here.', '```bash', 'ls -la', '```'];
        expect(findSuggested(capture.join('\n'))).toEqual({ kind: 'fence', command: 'ls -la' });
    });

    it('returns the last suggestion and nothing for prose or an unclosed fence', () => {
        expect(findSuggested(['! echo first', '```sh', 'echo second', '```', '  ! echo third', 'prose'].join('\n'))?.command).toBe('echo third');
        expect(findSuggested('⏺ All tests pass.\n  Nothing to run.')).toBeNull();
        expect(findSuggested('```bash\nnpm test')).toBeNull();
        expect(findSuggested('```python\nprint(1)\n```')).toBeNull();
    });
});

describe('suggested helpers', () => {
    it('keeps the real newline after a shell backslash', () => {
        expect(joinWraps(['docker run \\', '  --rm alpine'], 0)).toBe('docker run \\\n  --rm alpine');
    });

    it('reads the wrap width from the widest rule line', () => {
        expect(wrapWidth(['abc', RULE, '─'.repeat(30)])).toBe(60);
        expect(wrapWidth(['abc'])).toBe(0);
    });

    it('refuses empty text, control characters and invisible formatting characters', () => {
        expect(commandProblem('echo a\necho b')).toBeNull();
        expect(commandProblem('  ')).toMatch(/empty/);
        expect(commandProblem('echo \u001b[31m')).toMatch(/control/);
        expect(commandProblem('rm x\r')).toMatch(/control/);
        expect(commandProblem('echo safe ‮;hs.live')).toMatch(/invisible/);
        expect(commandProblem('rm​ -rf x')).toMatch(/invisible/);
    });

    it('refuses Unicode line separators, combining marks and any space but a plain one', () => {
        expect(commandProblem('echo a rm -rf x')).toMatch(/separator/);
        expect(commandProblem('echo a rm -rf x')).toMatch(/separator/);
        expect(commandProblem('rm -rf x')).toMatch(/space/);
        expect(commandProblem('rm　-rf x')).toMatch(/space/);
        expect(commandProblem('rm -rf x')).toMatch(/space/);
        expect(commandProblem('rm -rf x͏')).toMatch(/combining/);
        expect(commandProblem('rm -rf x⃝')).toMatch(/combining/);
    });

    it('sees the empty input box only when it is the last thing drawn', () => {
        expect(promptReady(['⏺ Done.', RULE, '> ', RULE, '  ⏵⏵ accept edits on'].join('\n'))).toBe(true);
        expect(promptReady([RULE, '❯', RULE, ''].join('\n'))).toBe(true);
        expect(promptReady([RULE, '> half a draft', RULE].join('\n'))).toBe(false);
        expect(promptReady([RULE, '> ', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', RULE].join('\n'))).toBe(false);
        expect(promptReady('⏺ Done.')).toBe(false);
        expect(promptReady(['     ' + RULE, '     >', '     ' + RULE].join('\n'))).toBe(false);
        expect(promptReady([RULE, '> ', RULE, ' ❯ 1. Yes', ' Esc to cancel'].join('\n'))).toBe(false);
    });

    it('runs a one-line ! command in a Claude session at its empty prompt and everything else in a new pane', () => {
        const ready = [RULE, '> ', RULE].join('\n');
        const idle = { agent: 'claude', agent_session_id: 'S', status: 'waitingForInput' };
        expect(runsInSession({ kind: 'bang', command: 'gh auth status' }, idle, ready)).toBe(true);
        expect(runsInSession({ kind: 'inline', command: 'gh auth status' }, { ...idle, status: 'idle' }, ready)).toBe(true);
        expect(runsInSession({ kind: 'fence', command: 'gh auth status' }, idle, ready)).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'docker run \\\n  --rm alpine' }, idle, ready)).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'docker run \\' }, idle, ready)).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'ls' }, { ...idle, status: 'running' }, ready)).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'ls' }, idle, 'Do you want to proceed?')).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'ls' }, { ...idle, status: undefined }, ready)).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'ls' }, { status: 'idle' }, ready)).toBe(false);
        expect(runsInSession({ kind: 'bang', command: 'ls' }, { ...idle, agent: 'codex' }, ready)).toBe(false);
    });
});
