import { createInterface } from 'node:readline';

import { writeErr } from './io.js';

/** Ask a yes/no question on stderr and read one line of stdin. Only "y" or "yes" is a yes; EOF is a no. */
export function confirm(question: string): Promise<boolean> {
    writeErr(`${question} [y/N] `);
    return new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin, terminal: false });
        let answered = false;
        lines.once('line', (line) => {
            answered = true;
            lines.close();
            resolve(/^\s*y(es)?\s*$/i.test(line));
        });
        lines.once('close', () => {
            if (!answered) resolve(false);
        });
    });
}
