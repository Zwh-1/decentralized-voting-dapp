# Schema migrations and the dual-slot constraint

Why this document exists: during a deploy, **two versions of the application run
against one database at the same time.** The old slot keeps serving while the new
one starts and is health-checked. So every migration must leave the old version
working, and the new version must tolerate the schema the old version expects.

That single constraint decides what may change in one release.

## The rule

**Allowed in one release**

- New tables
- New columns that are nullable or have a default
- New indexes
- New views

**Forbidden in one release**

- Dropping or renaming a column, table, or view the old version still reads
- Adding `NOT NULL` to an existing column without a default
- Changing a column's type in a way the old version cannot read
- Anything that makes the old version's queries fail

A migration that breaks the old version does not fail loudly at deploy time. The
new slot passes its health check (its own queries work), traffic moves, and then
the _idle_ slot — still running, still the rollback target — starts throwing
errors on any request it receives. The failure appears only if a rollback is
attempted, which is the worst possible moment to discover it.

## Destructive changes take two releases

To remove a column that is still in use:

**Release N — expand.** Add the replacement, backfill it, and write to both. The
old column stays, and both versions work.

**Release N+1 — contract.** After confirming no old version is running, drop the
old column. By now the only version in existence has not read it for a full
release cycle.

The cost is one extra release. The alternative is a release that cannot be rolled
back, which is a much larger cost paid on a day nobody chooses.

## Rollback does not roll back the schema

`rollback.sh` returns traffic to the previous slot and **does not touch the
database**. That is a decision, not an omission:

- Migrations are backward compatible precisely so the previous release can run
  against the current schema.
- Reversing a migration would destroy whatever the release being abandoned had
  already written, turning a bad release into data loss.
- So a rollback means: run the old image against the current schema.

**The consequence, stated plainly:** if a migration is ever written that is not
backward compatible, that release **cannot be rolled back** and must be fixed
forward. `rollback.sh` cannot detect this for you. It prints the warning on every
run for that reason.

## The check before every deploy

```bash
git log --oneline <previous-tag>..<new-tag> -- web/src/lib/db/schema.ts
```

Non-empty output means the release changes the schema. If it does, confirm it is
an expand or a contract step and nothing else. This is one line, it costs
nothing, and it prevents the single most damaging mistake available in this
design — which is why it belongs in the deploy checklist rather than in memory.

The schema has exactly one owner: `web/src/lib/db/schema.ts`, applied by
`web/scripts/migrate.ts` running as a one-shot `migrate` container. There is no
`docker-entrypoint-initdb.d` script and no second definition anywhere; the
`migrate` service runs **before** the new slot starts, while the old version is
still serving, so a failed migration costs nothing.

## Contribution rule

`CONTRIBUTING.md` has the short form: a schema change that is not backward
compatible must be split across two releases. It is the sixth invariant, and it is
the third one ("events and the cursor are written in one transaction") extended
from the runtime into the release process — both exist because state is shared
between things that are not stopped at the same moment.
