# Contributing to Life Cockpit

Thank you for helping make local project and time tracking easier to use.

Start with an issue describing the problem and a small reproducible example. Good first contributions include clearer onboarding, accessibility fixes, translations and tests for a reported bug. Discuss changes to storage or task semantics before building a large feature.

## Development

Use Node.js 24.16 or later in the 24.x line. Run `npm ci`, then `npm run build` and `npm test`. Windows desktop checks run with `npm run test:desktop` and `npm run desktop:build`.

Set `PCOS_DATA_DIR` to a new temporary directory before running development or UI experiments. A normal server otherwise uses the repository's `data` directory. Never reproduce a bug by sending a real user's ledger, backup or API key.

## Pull requests

- Explain the user-visible problem and the resulting behavior.
- Add or update tests when changing business rules, storage, security or process lifecycle.
- Keep completing a task, tracking actual time and recording an outcome independent.
- Check narrow layouts and keyboard access for interface changes.
- Run `npm run check:public` and inspect staged files before committing.
- Keep all screenshots and fixtures synthetic, with a visible example label where appropriate.

Code contributions are accepted under the MIT license. New assets need a clear source and redistribution license.

## Community

Be respectful and specific. Critique ideas and code, never people. Harassment, private-data disclosure and spam are not accepted. Use GitHub's reporting tools for abuse. The maintainer may remove harmful content or restrict participation.
