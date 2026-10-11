# Specs and design documents

Read this when your task implements or changes a spec. Plain Markdown; no editor or agent
tool is required to read or write any of it.

## Where things live

| Path                              | What                                                                                           | Status                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `docs/specs/<feature>/`           | Spec-driven features: `requirements.md`, `design.md`, `tasks.md`                               | Canonical for new specs                                                            |
| `.kiro/specs/<feature>/`          | Same three-file format, created before this convention                                         | Valid until moved here as whole directories; contents and numbering unchanged      |
| `docs/engineering/<topic>.md`     | Task-local engineering notes: measurements, investigations, design deltas too small for a spec | Canonical                                                                          |
| `docs/superpowers/{specs,plans}/` | Earlier single-file designs and implementation plans                                           | Frozen archive: still referenced from code, tests and config; do not add new files |

Whichever skill or tool helps you write a design, save the result in the paths above.

## The three files

- **`requirements.md`**: user stories and numbered acceptance criteria (`1.1`, `1.2`, ...).
  Numbers are stable identifiers: never renumber. Append new criteria, and mark retired
  ones as superseded in place.
- **`design.md`**: architecture, interfaces, data models and numbered **correctness
  properties**. Each property names the requirements it validates and becomes a property test.
- **`tasks.md`**: an ordered, dependency-sequenced checklist. Each task cites its criteria
  and any properties it implements:

  ```markdown
  - [ ] 4.5 Implement Source Manager
    - TCP client with auto-reconnect and exponential backoff
    - _Requirements: 1.1, 1.2_
    - **Property 3: Reconnect Backoff Bound**
  ```

A spec may reference another file with `#[[file:<path>]]`: read the referenced file too.
Cross-spec links are relative (`../decode-envelope/design.md`), so moving whole spec
directories together keeps them valid.

## Working a task list

1. Read `tasks.md` first: checked items are done.
2. Work tasks in order and check each one off (`- [x]`) when complete.
3. Stop at checkpoint tasks: verify tests pass and report before continuing.
4. Keep the spec honest about state: say what is reviewed design versus implemented, and
   which foundations exist unmounted versus wired into the running app. Keep stated
   dependency gates until they are actually met.
5. Reference requirement numbers in commit messages and in test comments.

Property tests use `fast-check` with at least `numRuns: 100` and carry the trace comment:

```ts
// Feature: <feature>, Property N: <name>
// Validates: Requirements X.Y, X.Z
```

Lane status, review IDs, ownership matrices and handoffs are private working notes and
stay in the ignored `.agents/` directory, never in a spec.
