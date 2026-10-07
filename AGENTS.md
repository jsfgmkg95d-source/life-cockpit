# Life Cockpit contributor guidance

Life Cockpit is a local-first Windows workspace for projects, tasks and time.

- Task completion is determined only by `status=done`; completion is reversible. Time and recorded outcomes remain independent.
- Keep plan duration, actual duration and outcomes separate. Never infer income or ability from time spent.
- Use synthetic fixtures and isolated `PCOS_DATA_DIR` directories for tests. Do not access another installation's ledger.
- Bind the backend to localhost. Online AI is optional and explicitly enabled by the user.
- Public releases must contain no databases, backups, credentials, private paths or personal project details.
- All redistributed artwork must be original or accompanied by its redistribution license.
- Run build, relevant tests and the public-file audit before release; validate the actual packaged entry point.
- Preserve user data during updates. Keep application files and user storage separate.
