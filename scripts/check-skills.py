#!/usr/bin/env python3
"""Validates every skills/<name>/SKILL.md against the Agent Skills specification.

Dependency-free on purpose (no PyYAML): the frontmatter it checks is a flat
`key: value` block, and pulling a YAML parser into CI to read two strings is not
worth the supply chain.

Checks:
  - the file opens with a `---` frontmatter block that is closed
  - `name` and `description` are present and non-empty
  - `name` is 1-64 chars, lowercase a-z / 0-9 / hyphens, no leading/trailing or
    doubled hyphens, and matches the parent directory (what the standard requires
    and what every installer assumes)
  - `description` is at most 1024 characters (harnesses truncate or drop it above that)
  - the frontmatter block parses as YAML (the fatal one: an unquoted `: ` inside a value
    turns it into a nested mapping and strict parsers, such as the skills.sh installer,
    drop the whole skill)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def frontmatter_block(path: Path) -> str | None:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "\n".join(lines[1:i])
    return None  # unterminated frontmatter


def unquoted_plain_scalars(block: str) -> list[tuple[int, str, str]]:
    """(lineno, key, value) for every top-level scalar written without quotes."""
    out = []
    for n, line in enumerate(block.splitlines(), start=1):
        if not line.strip() or line.startswith((" ", "\t", "#")):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        value = value.strip()
        if not value or value[0] in "\"'|>[{&*!%@`":
            continue
        out.append((n, key.strip(), value))
    return out


def yaml_problems(block: str) -> list[str]:
    """Catches what a strict YAML parser rejects, with or without PyYAML installed."""
    problems = [
        f"line {n}: `{key}` has an unquoted `: ` in its value, which YAML reads as a nested mapping"
        for n, key, value in unquoted_plain_scalars(block)
        if ": " in value or value.endswith(":")
    ]
    problems += [
        f"line {n}: `{key}` has an unquoted ` #` in its value, which YAML reads as a comment"
        for n, key, value in unquoted_plain_scalars(block)
        if " #" in value
    ]
    try:
        import yaml  # type: ignore
    except ImportError:
        return problems
    try:
        parsed = yaml.safe_load(block)
    except yaml.YAMLError as exc:
        return [*problems, f"YAML parser rejected the block: {exc}"]
    if not isinstance(parsed, dict):
        return [*problems, "the frontmatter block did not parse into a mapping"]
    return problems


def frontmatter(path: Path) -> dict[str, str] | None:
    block = frontmatter_block(path)
    if block is None:
        return None
    fields: dict[str, str] = {}
    for line in block.splitlines():
        if not line.strip() or line.startswith((" ", "\t", "#")):
            continue
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields


def main() -> int:
    skills = sorted(p for p in (ROOT / "skills").glob("*/SKILL.md"))
    if not skills:
        print("no skills/*/SKILL.md found", file=sys.stderr)
        return 1

    failures: list[str] = []
    for path in skills:
        rel = path.relative_to(ROOT)
        before = len(failures)
        fm = frontmatter(path)
        if fm is None:
            failures.append(f"{rel}: missing or unterminated YAML frontmatter")
            continue

        for problem in yaml_problems(frontmatter_block(path) or ""):
            failures.append(f"{rel}: {problem}")

        name = fm.get("name", "")
        description = fm.get("description", "")

        if not name:
            failures.append(f"{rel}: frontmatter has no `name`")
        elif not NAME_RE.match(name) or len(name) > 64:
            failures.append(f"{rel}: invalid `name` {name!r} (1-64 chars, [a-z0-9-], no edge/double hyphens)")
        elif name != path.parent.name:
            failures.append(f"{rel}: `name: {name}` does not match its directory {path.parent.name!r}")

        if not description:
            failures.append(f"{rel}: frontmatter has no `description`")
        elif len(description) > 1024:
            failures.append(f"{rel}: `description` is {len(description)} chars, the spec caps it at 1024")

        if len(failures) == before:
            print(f"ok {name} ({len(description)} char description)")

    if failures:
        print("\n" + "\n".join(f"FAIL {f}" for f in failures), file=sys.stderr)
        return 1
    print(f"\n{len(skills)} skill(s) valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
