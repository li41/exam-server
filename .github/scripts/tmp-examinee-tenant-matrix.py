#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

SOURCE = Path("packages/adapters/mysql/src/examinee-repository.ts")
TEST_COMMAND = ["corepack", "pnpm", "test:integration:mysql"]


@dataclass(frozen=True)
class Mutation:
    name: str
    anchor: str
    old: str
    widened: str
    blocked: str
    expect_widened_red: bool = True


MUTATIONS = [
    Mutation(
        "listGroups",
        "async listGroups(",
        'const predicates = ["g.tenant_id = ?", "g.deleted_at IS NULL"];',
        'const predicates = ["(g.tenant_id = ? OR 1=1)", "g.deleted_at IS NULL"];',
        'const predicates = ["(g.tenant_id = ? AND 1=0)", "g.deleted_at IS NULL"];',
    ),
    Mutation(
        "updateGroup",
        "async updateGroup(",
        "WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?",
        "WHERE id = ? AND (tenant_id = ? OR 1=1) AND deleted_at IS NULL AND version = ?",
        "WHERE id = ? AND (tenant_id = ? AND 1=0) AND deleted_at IS NULL AND version = ?",
    ),
    Mutation(
        "softDeleteGroup.target",
        "async softDeleteGroup(",
        "WHERE id = ? AND tenant_id = ?\n         LIMIT 1 FOR UPDATE",
        "WHERE id = ? AND (tenant_id = ? OR 1=1)\n         LIMIT 1 FOR UPDATE",
        "WHERE id = ? AND (tenant_id = ? AND 1=0)\n         LIMIT 1 FOR UPDATE",
    ),
    Mutation(
        "softDeleteGroup.children",
        "async softDeleteGroup(",
        "WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL\n         FOR UPDATE",
        "WHERE (tenant_id = ? OR 1=1) AND parent_id = ? AND deleted_at IS NULL\n         FOR UPDATE",
        "WHERE (tenant_id = ? AND 1=0) AND parent_id = ? AND deleted_at IS NULL\n         FOR UPDATE",
    ),
    Mutation(
        "softDeleteGroup.examineesUpdate",
        "async softDeleteGroup(",
        "WHERE tenant_id = ? AND deleted_at IS NULL\n           AND group_id IN (${placeholders})",
        "WHERE (tenant_id = ? OR 1=1) AND deleted_at IS NULL\n           AND group_id IN (${placeholders})",
        "WHERE (tenant_id = ? AND 1=0) AND deleted_at IS NULL\n           AND group_id IN (${placeholders})",
    ),
    Mutation(
        "softDeleteGroup.groupsUpdate",
        "async softDeleteGroup(",
        "WHERE tenant_id = ? AND deleted_at IS NULL\n           AND id IN (${placeholders})",
        "WHERE (tenant_id = ? OR 1=1) AND deleted_at IS NULL\n           AND id IN (${placeholders})",
        "WHERE (tenant_id = ? AND 1=0) AND deleted_at IS NULL\n           AND id IN (${placeholders})",
        expect_widened_red=False,
    ),
    Mutation(
        "listExaminees",
        "async listExaminees(",
        'const predicates = ["e.tenant_id = ?", "e.deleted_at IS NULL"];',
        'const predicates = ["(e.tenant_id = ? OR 1=1)", "e.deleted_at IS NULL"];',
        'const predicates = ["(e.tenant_id = ? AND 1=0)", "e.deleted_at IS NULL"];',
    ),
    Mutation(
        "listExaminees.groupTraversal",
        "async listExaminees(",
        "WHERE eg.tenant_id = ? AND eg.parent_id = ? AND eg.deleted_at IS NULL",
        "WHERE (eg.tenant_id = ? OR 1=1) AND eg.parent_id = ? AND eg.deleted_at IS NULL",
        "WHERE (eg.tenant_id = ? AND 1=0) AND eg.parent_id = ? AND eg.deleted_at IS NULL",
    ),
    Mutation(
        "getGroupWith",
        "private async getGroupWith(",
        "WHERE g.id = ? AND g.tenant_id = ? AND g.deleted_at IS NULL",
        "WHERE g.id = ? AND (g.tenant_id = ? OR 1=1) AND g.deleted_at IS NULL",
        "WHERE g.id = ? AND (g.tenant_id = ? AND 1=0) AND g.deleted_at IS NULL",
    ),
    Mutation(
        "throwGroupUpdateFailure",
        "private async throwGroupUpdateFailure(",
        "WHERE id = ? AND tenant_id = ? LIMIT 1",
        "WHERE id = ? AND (tenant_id = ? OR 1=1) LIMIT 1",
        "WHERE id = ? AND (tenant_id = ? AND 1=0) LIMIT 1",
    ),
]


def restore() -> str:
    subprocess.run(["git", "checkout", "--", str(SOURCE)], check=True)
    return SOURCE.read_text()


def mutate(mutation: Mutation, replacement: str) -> None:
    text = restore()
    anchor_index = text.find(mutation.anchor)
    if anchor_index < 0:
        raise RuntimeError(f"missing anchor for {mutation.name}: {mutation.anchor}")
    match_index = text.find(mutation.old, anchor_index)
    if match_index < 0:
        raise RuntimeError(f"missing target for {mutation.name}: {mutation.old}")
    next_anchor = len(text)
    for marker in ("\n  async ", "\n  private "):
        candidate = text.find(marker, anchor_index + len(mutation.anchor))
        if candidate >= 0:
            next_anchor = min(next_anchor, candidate)
    if match_index >= next_anchor:
        raise RuntimeError(f"target for {mutation.name} fell outside anchored method")
    if text.find(mutation.old, match_index + 1, next_anchor) >= 0:
        raise RuntimeError(f"target for {mutation.name} is ambiguous inside anchored method")
    SOURCE.write_text(text[:match_index] + replacement + text[match_index + len(mutation.old) :])


def run_tests(label: str) -> tuple[bool, str]:
    result = subprocess.run(
        TEST_COMMAND,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )
    red = result.returncode != 0
    tail = "\n".join(result.stdout.splitlines()[-50:])
    print(f"{label}: {'RED' if red else 'GREEN'} (exit={result.returncode})")
    return red, tail


def main() -> int:
    restore()
    baseline_red, baseline_tail = run_tests("baseline")
    if baseline_red:
        print(baseline_tail)
        raise SystemExit("baseline integration suite must be green")

    rows: list[tuple[str, str, str, str]] = []
    unexpected: list[str] = []

    for mutation in MUTATIONS:
        mutate(mutation, mutation.widened)
        widened_red, widened_tail = run_tests(f"{mutation.name} OR 1=1")
        expected = mutation.expect_widened_red
        if widened_red != expected:
            unexpected.append(
                f"{mutation.name} OR 1=1 expected {'RED' if expected else 'GREEN'} but got {'RED' if widened_red else 'GREEN'}\n{widened_tail}"
            )

        mutate(mutation, mutation.blocked)
        blocked_red, blocked_tail = run_tests(f"{mutation.name} AND 1=0")
        if not blocked_red:
            unexpected.append(
                f"{mutation.name} AND 1=0 expected RED but got GREEN\n{blocked_tail}"
            )

        note = ""
        if mutation.name == "softDeleteGroup.groupsUpdate":
            note = "single OR is schema-equivalent because groupIds are already scoped and id is the global PK"
        rows.append(
            (
                mutation.name,
                "RED" if widened_red else "GREEN",
                "RED" if blocked_red else "GREEN",
                note,
            )
        )

    # The final group UPDATE tenant predicate is a defense-in-depth guard. A single
    # OR mutation cannot widen the result while groupIds are sourced from the
    # preceding tenant-scoped child query and id is globally unique. Widen both
    # the child-source tenant predicate and the final UPDATE tenant predicate to
    # demonstrate that the final guard protects a corrupt foreign child once the
    # upstream guard is also lost.
    text = restore()
    children = next(m for m in MUTATIONS if m.name == "softDeleteGroup.children")
    groups_update = next(m for m in MUTATIONS if m.name == "softDeleteGroup.groupsUpdate")
    for mutation in (children, groups_update):
        anchor_index = text.find(mutation.anchor)
        match_index = text.find(mutation.old, anchor_index)
        if anchor_index < 0 or match_index < 0:
            raise RuntimeError(f"missing compound target for {mutation.name}")
        text = text[:match_index] + mutation.widened + text[match_index + len(mutation.old) :]
    SOURCE.write_text(text)
    compound_red, compound_tail = run_tests(
        "softDeleteGroup children+groupsUpdate OR 1=1 compound"
    )
    if not compound_red:
        unexpected.append(
            "compound defense-in-depth mutation expected RED but got GREEN\n" + compound_tail
        )

    restore()

    table = [
        "| predicate | OR 1=1 | AND 1=0 | note |",
        "| --- | --- | --- | --- |",
    ]
    table.extend(f"| `{name}` | {wide} | {block} | {note} |" for name, wide, block, note in rows)
    table.append(
        f"| `softDeleteGroup.children + groupsUpdate` compound | {'RED' if compound_red else 'GREEN'} | — | defense-in-depth substitute for the schema-equivalent single OR mutation |"
    )
    summary = "\n".join(table) + "\n"
    Path("tmp-examinee-tenant-mutation-matrix.md").write_text(summary)
    print("\n" + summary)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as handle:
            handle.write("## Examinee tenant mutation matrix\n\n" + summary)

    if unexpected:
        print("\nUNEXPECTED MATRIX RESULTS\n" + "\n\n".join(unexpected))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
