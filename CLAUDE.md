# CLAUDE.md

Guidance for AI coding assistants (and people) working in this repository.

## Engineering principles

- **YAGNI**: Don't build it until you need it.
- **DRY**: Extract patterns after the second duplication, not before.
- **Fail Fast**: Explicit errors beat silent failures.
- **Simple First**: Write the obvious solution; optimize only if needed.
- **Delete Aggressively**: Less code = fewer bugs.
- **Semantic Naming**: Use long, self-explanatory names for variables, parameters and API endpoints, so
  both people and AI tools can understand them (e.g. `wait_until_obs_is_saved=true` instead of `wait=true`).

## Project conventions

- Backup files are only ever opened read-only. Anything that writes produces a new file.
- Work on a feature branch, commit at each meaningful step, run `npm test` before each commit, and push
  the branch to `origin`.
- Keep the notes in step with each commit: tick items in `doc/TODO.md`, add an entry to `doc/WORKLOG.md`,
  and update the format notes in `doc/` when the understanding of a format changes.
- Format knowledge that hasn't been checked against a real backup is labelled as such in the docs.
