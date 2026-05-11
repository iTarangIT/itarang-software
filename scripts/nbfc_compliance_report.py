#!/usr/bin/env python3
"""
nbfc_compliance_report.py — post-run AC compliance report for /nbfc-fullflow.

Builds a full BRD coverage matrix for the most recent journey run.

Inputs:
  - docs/nbfc/_convergence/_preflight_acs.json  (from nbfc_brd_revalidate.py)
  - tests/e2e/nbfc/_journey_full_brd.headed.spec.ts (statically grepped to
    learn which ACs the journey claims to test)
  - docs/nbfc/_convergence/journey.jsonl        (recorder failure log)
  - docs/nbfc/_convergence/_progress.json       (last-known good unit cursor)
  - docs/nbfc/_convergence/results.json         (optional Playwright JSON
    reporter output — adds 'skipped' detection)
  - docs/nbfc/manifest.json                     (per-unit status lookup so
    blocked / superseded units render the right reason)

Output:
  - docs/nbfc/_convergence/compliance_<timestamp>.md
  - docs/nbfc/_convergence/compliance_<timestamp>.json
  - docs/nbfc/_convergence/compliance_latest.md  (symlink-style copy)
  - docs/nbfc/_convergence/compliance_latest.json

Per-AC status (in priority order, first match wins):
  - failed           : journey labeled this AC AND a step_failure /
                       response_error was recorded for that label
  - skipped          : the unit was test.skip()'d (manifest blocked,
                       RESUME_FROM past it, or per-test test.skip())
  - passed           : journey labeled this AC AND no failure recorded for it
  - not_tested       : extracted into a YAML but the journey has no step
                       labeled with this AC id
  - yaml_unsupported : the AC's distinguishing tokens (URL paths, status codes,
                       field names) don't appear in the BRD section that maps
                       to this unit — flagged by the pre-flight re-validation
                       as a potentially hallucinated AC.

Plus a separate `brd_uncovered` block listing BRD sentences that look like
specs (MUST / returns / rejects …) but have no matching YAML AC — coverage
holes in the extraction.

Run:
  python3 scripts/nbfc_compliance_report.py
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONV = ROOT / "docs" / "nbfc" / "_convergence"
PREFLIGHT_PATH = CONV / "_preflight_acs.json"
JSONL_PATH = CONV / "journey.jsonl"
PROGRESS_PATH = CONV / "_progress.json"
RESULTS_PATH = CONV / "results.json"
MANIFEST_PATH = ROOT / "docs" / "nbfc" / "manifest.json"
SPEC_PATH = ROOT / "tests" / "e2e" / "nbfc" / "_journey_full_brd.headed.spec.ts"

STEP_LABEL_RE = re.compile(r"\bE-(\d{3}):AC(\d{1,2})\b")

PERSONA_BLOCKS: list[tuple[str, str, str, list[str]]] = [
    ("A", "itarang_super_admin", "§6.0 admin onboarding pipeline",
     ["E-001", "E-002", "E-003", "E-004", "E-005", "E-006", "E-007", "E-008", "E-009", "E-010", "E-011", "E-012", "E-013"]),
    ("B", "nbfc_tenant_user", "§6.1.2-4 tenant portal nav / portfolio / leads",
     ["E-025", "E-026", "E-027", "E-028"]),
    ("C", "itarang_super_admin", "§6.1.5 admin nightly score compute",
     ["E-029", "E-030"]),
    ("D", "nbfc_tenant_user", "§6.1.6-7 tenant risk actions / recovery / auction",
     ["E-031", "E-032", "E-033", "E-034", "E-035", "E-036", "E-037", "E-038", "E-039"]),
    ("E", "itarang_super_admin", "§6.2 telemetry plane",
     ["E-045", "E-046", "E-047", "E-048", "E-049", "E-050", "E-051"]),
    ("F", "itarang_super_admin", "§6.3 admin overlay",
     ["E-065", "E-066", "E-067", "E-068", "E-069", "E-070", "E-071", "E-072"]),
    ("G", "kyc_reviewer", "§6.3.3 second-approver releases pending change",
     ["E-068"]),
    ("H", "nbfc_tenant_user", "§6.4.2-3 compliance + dual-approval primitive",
     ["E-080", "E-081", "E-082", "E-083", "E-084", "E-085", "E-086", "E-087", "E-088", "E-089"]),
    ("I", "nbfc_tenant_user", "§6.4.4-5 DPDPA consent + score explainability",
     ["E-090", "E-091", "E-092", "E-093"]),
    ("J", "itarang_super_admin", "§6.4.4 admin DPDPA retention job",
     ["E-091"]),
    ("K", "itarang_super_admin", "sync-audit cross-cutting",
     ["E-100", "E-101", "E-102", "E-103", "E-104", "E-105"]),
]


def _load_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _load_journey_failures() -> set[tuple[str, str]]:
    """Return {(unit_id, ac_id)} for every AC label that failed in this run."""
    if not JSONL_PATH.exists():
        return set()
    failed: set[tuple[str, str]] = set()
    for line in JSONL_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = ev.get("kind")
        if kind not in ("step_failure", "response_error", "db_snapshot_mismatch"):
            continue
        step = ev.get("step", "")
        m = STEP_LABEL_RE.search(step)
        if not m:
            continue
        failed.add((f"E-{m.group(1)}", f"AC{int(m.group(2))}"))
    return failed


def _load_journey_labels_from_spec() -> set[tuple[str, str]]:
    """Statically grep the spec for every E-###:ACn step label."""
    if not SPEC_PATH.exists():
        return set()
    out: set[tuple[str, str]] = set()
    text = SPEC_PATH.read_text(encoding="utf-8")
    for m in STEP_LABEL_RE.finditer(text):
        out.add((f"E-{m.group(1)}", f"AC{int(m.group(2))}"))
    return out


def _load_skipped_units_from_results() -> set[str]:
    """If --reporter=json was used, mine results.json for skipped tests."""
    data = _load_json(RESULTS_PATH)
    if not data:
        return set()
    skipped: set[str] = set()

    def walk(suite: dict[str, Any]) -> None:
        for spec in suite.get("specs", []):
            title = spec.get("title", "")
            m = re.search(r"\bE-(\d{3})\b", title)
            if not m:
                continue
            uid = f"E-{m.group(1)}"
            for t in spec.get("tests", []):
                # A test is "skipped" if all its results are 'skipped' or 'expected'.
                results = t.get("results", [])
                if results and all(r.get("status") == "skipped" for r in results):
                    skipped.add(uid)
        for child in suite.get("suites", []):
            walk(child)

    for s in data.get("suites", []):
        walk(s)
    return skipped


def _classify(
    rows: list[dict[str, Any]],
    journey_labels: set[tuple[str, str]],
    failures: set[tuple[str, str]],
    skipped_units: set[str],
    blocked_units: dict[str, str],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        uid = row["unit_id"]
        ac_id = row["ac_id"]
        key = (uid, ac_id)
        labeled = key in journey_labels
        coverage_verdict = (row.get("coverage") or {}).get("verdict")

        if key in failures:
            status = "failed"
            reason = "journey recorded a step_failure or response_error for this AC label"
        elif uid in skipped_units:
            status = "skipped"
            reason = "the unit was test.skip()'d this run (RESUME_FROM cursor past it, or all-tests-in-unit skipped)"
        elif uid in blocked_units:
            status = "skipped"
            reason = f"manifest status={blocked_units[uid]}"
        elif labeled:
            status = "passed"
            reason = "journey labeled this AC and recorded no failure for it"
        elif coverage_verdict == "yaml_unsupported":
            status = "yaml_unsupported"
            reason = "pre-flight re-validation found no distinguishing token from this AC's statement in the BRD section text"
        else:
            status = "not_tested"
            reason = "extracted into a YAML, but the journey has no rec.step('E-###:ACn:...') label for it"

        out.append(
            {
                **row,
                "status": status,
                "reason": reason,
                "labeled_in_journey": labeled,
            }
        )
    return out


def _render_markdown(
    rows: list[dict[str, Any]],
    summary: dict[str, int],
    yaml_unsupported: list[dict[str, Any]],
    brd_uncovered: list[dict[str, Any]],
    unmapped_sections: list[dict[str, Any]],
    timestamp: str,
) -> str:
    icons = {
        "passed": ":white_check_mark:",
        "failed": ":x:",
        "skipped": ":fast_forward:",
        "not_tested": ":grey_question:",
        "yaml_unsupported": ":warning:",
    }

    lines: list[str] = []
    lines.append(f"# NBFC §6 BRD compliance report — {timestamp}")
    lines.append("")
    lines.append("_Auto-generated by `scripts/nbfc_compliance_report.py` after a `/nbfc-fullflow` run._")
    lines.append("")
    lines.append("## Headline")
    lines.append("")
    total = summary["total"]
    if total:
        passed_pct = 100 * summary["passed"] // total
        lines.append(f"**{summary['passed']} / {total} ACs passed ({passed_pct}%)**, "
                     f"{summary['failed']} failed, "
                     f"{summary['skipped']} skipped, "
                     f"{summary['not_tested']} not tested, "
                     f"{summary['yaml_unsupported']} unsupported by BRD.")
    lines.append("")
    lines.append("| Status | Count | Meaning |")
    lines.append("| --- | ---: | --- |")
    lines.append(f"| {icons['passed']} passed | {summary['passed']} | Journey labeled the AC and the step ran clean. |")
    lines.append(f"| {icons['failed']} failed | {summary['failed']} | Journey labeled the AC and the recorder caught a step_failure / response_error. |")
    lines.append(f"| {icons['skipped']} skipped | {summary['skipped']} | Unit was test.skip()'d (RESUME_FROM past it, blocked in manifest, or test.skip(true,...)). |")
    lines.append(f"| {icons['not_tested']} not_tested | {summary['not_tested']} | YAML extracted the AC but the journey has no rec.step label for it — coverage gap inside the journey. |")
    lines.append(f"| {icons['yaml_unsupported']} yaml_unsupported | {summary['yaml_unsupported']} | Pre-flight re-validation found no distinguishing token from this AC's statement in the BRD section text. Possible hallucinated AC, or BRD section header changed. |")
    lines.append("")

    if yaml_unsupported:
        lines.append("## :warning: YAML ACs unsupported by BRD section text")
        lines.append("")
        lines.append("These ACs live in `docs/nbfc/brd_extract/E-*.yaml` but their distinguishing tokens "
                     "(URL paths, status codes, snake_case fields) don't appear in the BRD section the YAML "
                     "claims to come from. May be hallucinated; may be a stale section pointer.")
        lines.append("")
        lines.append("| Unit | AC | Section | Statement |")
        lines.append("| --- | --- | --- | --- |")
        for g in yaml_unsupported:
            stmt = g["statement"].replace("|", "\\|")
            lines.append(f"| {g['unit_id']} | {g['ac_id']} | §{g.get('section','?')} | {stmt[:200]} |")
        lines.append("")

    if brd_uncovered:
        lines.append("## :grey_question: BRD spec sentences with no matching AC")
        lines.append("")
        lines.append("Sentences in the BRD that look like specs (MUST / returns / rejects …) but have no "
                     "YAML AC whose statement shares any distinguishing token. Likely missing ACs.")
        lines.append("")
        lines.append("| Unit | Section | Sentence |")
        lines.append("| --- | --- | --- |")
        for g in brd_uncovered[:50]:  # cap — these can be noisy
            sent = g["sentence"].replace("|", "\\|")
            lines.append(f"| {g['unit_id']} | §{g['section']} | {sent[:240]} |")
        if len(brd_uncovered) > 50:
            lines.append(f"| _… {len(brd_uncovered) - 50} more — see compliance_latest.json_ | | |")
        lines.append("")

    if unmapped_sections:
        lines.append("## :information_source: Units with no matching BRD section header")
        lines.append("")
        lines.append("These units' YAMLs claim a `source_section` that doesn't exist in the BRD .docx, so "
                     "we couldn't run token-overlap coverage for them. Most are sync-audit cross-cutting units "
                     "that legitimately have no BRD section.")
        lines.append("")
        lines.append("| Unit | Claimed section |")
        lines.append("| --- | --- |")
        for g in unmapped_sections:
            lines.append(f"| {g['unit_id']} | {g.get('claimed_section','?')} |")
        lines.append("")

    # Per-block compliance matrix.
    lines.append("## Compliance matrix (per persona block)")
    lines.append("")
    rows_by_unit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        rows_by_unit[r["unit_id"]].append(r)

    seen: set[str] = set()
    for block, persona, section, ids in PERSONA_BLOCKS:
        lines.append(f"### Block {block} — {section}")
        lines.append("")
        lines.append(f"Persona: `{persona}`")
        lines.append("")
        lines.append("| Unit | AC | Status | Statement |")
        lines.append("| --- | --- | --- | --- |")
        for uid in ids:
            seen.add(uid)
            unit_rows = sorted(rows_by_unit.get(uid, []), key=lambda r: int(r["ac_id"][2:]))
            if not unit_rows:
                lines.append(f"| {uid} | — | {icons['not_tested']} not_tested | _no ACs known_ |")
                continue
            for r in unit_rows:
                stmt = r["statement"].replace("|", "\\|")[:160]
                lines.append(f"| {uid} | {r['ac_id']} | {icons.get(r['status'], '?')} {r['status']} | {stmt} |")
        lines.append("")

    # Catch any unit not in a block.
    orphan_units = sorted(set(rows_by_unit) - seen)
    if orphan_units:
        lines.append("### :warning: Orphan units (in inventory but not mapped to a block)")
        lines.append("")
        lines.append("| Unit | AC | Status | Statement |")
        lines.append("| --- | --- | --- | --- |")
        for uid in orphan_units:
            for r in sorted(rows_by_unit[uid], key=lambda r: int(r["ac_id"][2:])):
                stmt = r["statement"].replace("|", "\\|")[:160]
                lines.append(f"| {uid} | {r['ac_id']} | {icons.get(r['status'], '?')} {r['status']} | {stmt} |")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    preflight = _load_json(PREFLIGHT_PATH)
    if not preflight:
        print(
            "error: preflight inventory missing. Run `python3 scripts/nbfc_brd_revalidate.py` first.",
            file=sys.stderr,
        )
        return 2

    manifest = _load_json(MANIFEST_PATH) or {}
    blocked_units: dict[str, str] = {}
    for uid, u in (manifest.get("units") or {}).items():
        status = (u or {}).get("status", "")
        if status.startswith("blocked") or status.startswith("superseded"):
            blocked_units[uid] = status

    journey_labels = _load_journey_labels_from_spec()
    failures = _load_journey_failures()
    skipped_units = _load_skipped_units_from_results()

    classified = _classify(
        preflight["rows"], journey_labels, failures, skipped_units, blocked_units
    )

    summary = {
        "total": len(classified),
        "passed": sum(1 for r in classified if r["status"] == "passed"),
        "failed": sum(1 for r in classified if r["status"] == "failed"),
        "skipped": sum(1 for r in classified if r["status"] == "skipped"),
        "not_tested": sum(1 for r in classified if r["status"] == "not_tested"),
        "yaml_unsupported": sum(1 for r in classified if r["status"] == "yaml_unsupported"),
    }

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    md_path = CONV / f"compliance_{timestamp}.md"
    json_path = CONV / f"compliance_{timestamp}.json"
    md_latest = CONV / "compliance_latest.md"
    json_latest = CONV / "compliance_latest.json"

    yaml_unsupported = preflight.get("yaml_unsupported", [])
    brd_uncovered = preflight.get("brd_uncovered", [])
    unmapped_sections = preflight.get("unmapped_sections", [])

    md = _render_markdown(
        classified,
        summary,
        yaml_unsupported,
        brd_uncovered,
        unmapped_sections,
        timestamp,
    )
    payload = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "summary": summary,
        "rows": classified,
        "yaml_unsupported": yaml_unsupported,
        "brd_uncovered": brd_uncovered,
        "unmapped_sections": unmapped_sections,
        "inputs": {
            "preflight": str(PREFLIGHT_PATH.relative_to(ROOT)),
            "spec": str(SPEC_PATH.relative_to(ROOT)),
            "jsonl": str(JSONL_PATH.relative_to(ROOT)) if JSONL_PATH.exists() else None,
            "results": str(RESULTS_PATH.relative_to(ROOT)) if RESULTS_PATH.exists() else None,
            "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        },
    }

    CONV.mkdir(parents=True, exist_ok=True)
    md_path.write_text(md, encoding="utf-8")
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # Plain copies (not symlinks — Windows-friendly, git-friendly).
    md_latest.write_text(md, encoding="utf-8")
    json_latest.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    total = summary["total"] or 1
    print(f"nbfc_compliance_report: wrote {md_path.relative_to(ROOT)}")
    print(f"  {summary['passed']}/{total} passed ({100 * summary['passed'] // total}%) | "
          f"failed={summary['failed']} skipped={summary['skipped']} "
          f"not_tested={summary['not_tested']} yaml_unsupported={summary['yaml_unsupported']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
