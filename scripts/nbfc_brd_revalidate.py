#!/usr/bin/env python3
"""
nbfc_brd_revalidate.py — pre-flight AC re-validation for /nbfc-fullflow.

The BRD .docx itself never writes "AC1:" / "AC2:" — those labels are synthesised
by `/nbfc extract` when it builds docs/nbfc/brd_extract/E-*.yaml. So this script
doesn't try to pull literal AC IDs out of the .docx. Instead it does a
token-overlap *coverage check* in both directions:

  yaml_unsupported : a YAML AC whose distinguishing tokens (API path, status
                     code, field name, etc.) cannot be found anywhere in the
                     BRD section that maps to that unit.  May be a hallucinated
                     AC, or the BRD section header in the manifest may be wrong.

  brd_uncovered    : a sentence in the BRD section that smells like a spec
                     ("MUST", "SHALL", "returns 4xx", "rejects when …") that no
                     YAML AC for that unit appears to cover.  May be a missing
                     AC.

  unmapped_section : a unit whose source_section header (per the YAML's
                     `source_section` field) cannot be located in the BRD .docx
                     at all.  Token matching for that unit is skipped because we
                     can't carve out its slice of text.

The canonical AC inventory written to `_preflight_acs.json` keeps every YAML AC
verbatim, plus a `coverage` field annotating each one with the verdict above.
The end-of-run compliance report (nbfc_compliance_report.py) keys off this file
to colour ACs as `extraction_gap` (≈ yaml_unsupported) without re-doing the work.

Run:
  python3 scripts/nbfc_brd_revalidate.py
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml  # PyYAML

ROOT = Path(__file__).resolve().parent.parent
BRD_CANDIDATES = [
    ROOT / "docs" / "nbfc" / "Section_6_NBFC_Telemetry_Admin_BRD (1).docx",
    ROOT / "docs" / "nbfc" / "Section_6_NBFC_Telemetry_Admin_BRD (1) (1).docx",
]
YAML_DIR = ROOT / "docs" / "nbfc" / "brd_extract"
OUT_PATH = ROOT / "docs" / "nbfc" / "_convergence" / "_preflight_acs.json"
IGNORE_PATH = ROOT / "docs" / "nbfc" / "_convergence" / "_preflight_acs_ignore.json"

# Tokens that distinguish one AC from another. We extract these from the AC
# statement and look for them in the BRD section text. URL paths and HTTP codes
# are the most reliable signals; field names (snake_case identifiers) are next.
URL_PATH_RE = re.compile(r"/(?:api|admin|nbfc|iot|webhooks?|dpdpa)[/\w{}\-]*", re.IGNORECASE)
HTTP_CODE_RE = re.compile(r"\b(?:200|201|202|204|400|401|403|404|409|422|500)\b")
SNAKE_RE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b")
QUOTED_RE = re.compile(r"['\"]([^'\"\n]{2,40})['\"]")
SPEC_VERB_RE = re.compile(
    r"\b(?:MUST|SHALL|must|shall|should|returns?|rejects?|persist[s]?|enforces?|emits?|requires?)\b"
)

# Section heading like "6.0.3 NBFC Master Details Form".
SECTION_HEADING_RE = re.compile(r"^(\d+\.\w+(?:\.\d+)?(?:\.\d+)?)\b\s+(.+)$")

# Stop tokens for sentence splitting inside a section.
SENT_SPLIT_RE = re.compile(r"(?<=[\.\!\?])\s+(?=[A-Z(])")


def _load_brd_paragraphs() -> tuple[Path, list[str]]:
    for path in BRD_CANDIDATES:
        if path.exists():
            brd_path = path
            break
    else:
        raise SystemExit(
            f"BRD .docx not found at any of: {[str(p) for p in BRD_CANDIDATES]}"
        )
    with zipfile.ZipFile(brd_path) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    p_re = re.compile(r"<w:p\b[^>]*>(.*?)</w:p>", re.DOTALL)
    t_re = re.compile(r"<w:t\b[^>]*>(.*?)</w:t>", re.DOTALL)
    paragraphs: list[str] = []
    for pm in p_re.finditer(xml):
        text = "".join(t_re.findall(pm.group(1))).strip()
        if text:
            # Decode the small set of XML entities Word emits.
            text = (text.replace("&apos;", "'").replace("&amp;", "&")
                        .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
            paragraphs.append(text)
    return brd_path, paragraphs


def _carve_sections(paragraphs: list[str]) -> dict[str, str]:
    """Slice paragraphs into {section_id → joined section body}."""
    sections: dict[str, list[str]] = {}
    current = ""
    for line in paragraphs:
        m = SECTION_HEADING_RE.match(line.strip())
        if m and re.match(r"^\d+\.\d+", m.group(1)):
            current = m.group(1)
            sections.setdefault(current, []).append(line)
        elif current:
            sections[current].append(line)
    return {k: "\n".join(v) for k, v in sections.items()}


def _load_yaml_units() -> dict[str, dict[str, Any]]:
    units: dict[str, dict[str, Any]] = {}
    if not YAML_DIR.is_dir():
        raise SystemExit(f"docs/nbfc/brd_extract/ not found at {YAML_DIR}")
    for path in sorted(YAML_DIR.glob("E-*.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as e:
            print(f"  warn: failed to parse {path.name}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            continue
        uid = data.get("id") or path.stem.split("_")[0]
        units[uid] = data
    return units


def _extract_tokens(text: str) -> set[str]:
    """Pull distinguishing tokens; also expand snake_case and URL paths into
    their human-readable forms so we can match against BRD prose."""
    out: set[str] = set()
    for m in URL_PATH_RE.findall(text):
        out.add(m.lower())
        # Also add each path fragment (e.g. /admin/nbfc/{nbfcId}/lsp-agreement
        # → "lsp-agreement", "lsp agreement").
        for frag in re.split(r"[/{}]+", m):
            if 4 <= len(frag) <= 30 and "-" in frag:
                out.add(frag.lower())
                out.add(frag.lower().replace("-", " "))
    for m in HTTP_CODE_RE.findall(text):
        out.add(m)
    for m in SNAKE_RE.findall(text):
        if len(m) >= 5:
            out.add(m.lower())
            # snake_case → space-separated form ("grievance_officer_name" →
            # "grievance officer name") so it can match BRD prose.
            spaced = m.replace("_", " ")
            out.add(spaced.lower())
    for m in QUOTED_RE.findall(text):
        if 3 <= len(m) <= 40:
            out.add(m.lower())
    # Drop tokens so generic they'd match anywhere in the BRD.
    for noise in ("status", "post", "get", "patch", "delete", "true", "false"):
        out.discard(noise)
    return out


def _check_ac_against_section(ac_statement: str, section_text: str) -> dict[str, Any]:
    """Return overlap stats for one AC vs one section's text."""
    ac_tokens = _extract_tokens(ac_statement)
    if not ac_tokens:
        return {"verdict": "no_distinguishing_tokens", "matched": [], "missing": []}
    sec_lower = section_text.lower()
    matched = sorted(t for t in ac_tokens if t in sec_lower)
    missing = sorted(t for t in ac_tokens if t not in sec_lower)
    # Ratio threshold: AC is "supported" if at least 30% of its distinguishing
    # tokens land somewhere in the BRD section. We're not trying to prove the
    # AC is verbatim from the BRD — we're trying to catch hallucinated ACs.
    if not matched:
        verdict = "yaml_unsupported"
    elif len(matched) / max(len(ac_tokens), 1) < 0.3:
        verdict = "weakly_supported"
    elif missing:
        verdict = "partial"
    else:
        verdict = "supported"
    return {"verdict": verdict, "matched": matched, "missing": missing}


def _extract_spec_sentences(section_text: str) -> list[str]:
    """Pull spec-like sentences (those with MUST / returns / rejects / etc.)."""
    out: list[str] = []
    seen: set[str] = set()
    for chunk in section_text.splitlines():
        chunk = chunk.strip()
        if len(chunk) < 30 or len(chunk) > 400:
            continue
        for sent in SENT_SPLIT_RE.split(chunk):
            sent = sent.strip()
            if not (40 <= len(sent) <= 280):
                continue
            if SPEC_VERB_RE.search(sent) is None:
                continue
            key = re.sub(r"\s+", " ", sent.lower())[:120]
            if key in seen:
                continue
            seen.add(key)
            out.append(sent)
    return out


def _load_ignore() -> set[tuple[str, str]]:
    if not IGNORE_PATH.exists():
        return set()
    try:
        raw = json.loads(IGNORE_PATH.read_text(encoding="utf-8"))
        return {(r["unit_id"], r["ac_id"]) for r in raw.get("ignored", [])}
    except (json.JSONDecodeError, KeyError, TypeError, OSError):
        return set()


def main() -> int:
    print("nbfc_brd_revalidate: parsing BRD .docx and YAML extracts...")
    brd_path, paragraphs = _load_brd_paragraphs()
    sections = _carve_sections(paragraphs)
    yaml_units = _load_yaml_units()
    ignored = _load_ignore()
    print(f"  BRD: {len(paragraphs)} paragraphs across {len(sections)} numbered sections")
    print(f"  YAMLs: {len(yaml_units)} units")

    rows: list[dict[str, Any]] = []
    yaml_unsupported: list[dict[str, Any]] = []
    brd_uncovered: list[dict[str, Any]] = []
    unmapped_sections: list[dict[str, Any]] = []

    for uid in sorted(yaml_units):
        data = yaml_units[uid]
        section_id = str(data.get("source_section", "")).strip()
        section_text = sections.get(section_id, "")
        if not section_text:
            unmapped_sections.append(
                {
                    "unit_id": uid,
                    "claimed_section": section_id,
                    "reason": "YAML's source_section header not found in BRD .docx — section may have been renumbered, or this unit is sync-audit cross-cutting (no BRD section by design).",
                }
            )

        ac_items = data.get("acceptance_criteria") or []
        for item in ac_items:
            if not isinstance(item, dict):
                continue
            ac_id = str(item.get("id", "")).strip()
            statement = str(item.get("statement", "")).strip()
            if not ac_id:
                continue

            row: dict[str, Any] = {
                "unit_id": uid,
                "ac_id": ac_id,
                "statement": statement,
                "source_section": section_id,
                "test_layer": item.get("test_layer"),
                "test_name": item.get("test_name"),
                "source": "yaml",  # all rows originate in a YAML; BRD adds coverage signal
            }

            if section_text:
                cov = _check_ac_against_section(statement, section_text)
                row["coverage"] = cov
                if cov["verdict"] == "yaml_unsupported" and (uid, ac_id) not in ignored:
                    yaml_unsupported.append(
                        {
                            "unit_id": uid,
                            "ac_id": ac_id,
                            "statement": statement,
                            "section": section_id,
                            "reason": "no distinguishing token from this AC's statement was found in the BRD section text",
                        }
                    )
            else:
                row["coverage"] = {"verdict": "section_missing", "matched": [], "missing": []}
            rows.append(row)

        # Now go the other way: per-section spec sentences vs this unit's YAML ACs.
        if section_text and ac_items:
            yaml_blob = "\n".join(str(it.get("statement", "")) for it in ac_items if isinstance(it, dict)).lower()
            for sent in _extract_spec_sentences(section_text):
                tokens = _extract_tokens(sent)
                if not tokens:
                    continue
                # Heuristic: if NONE of the sentence's distinguishing tokens
                # appear in the unit's combined YAML AC text, that sentence is
                # likely an uncovered spec.
                if not any(t in yaml_blob for t in tokens):
                    brd_uncovered.append(
                        {
                            "unit_id": uid,
                            "section": section_id,
                            "sentence": sent[:280],
                            "tokens": sorted(tokens)[:6],
                        }
                    )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "brd_path": str(brd_path),
                "rows": rows,
                "yaml_unsupported": yaml_unsupported,
                "brd_uncovered": brd_uncovered,
                "unmapped_sections": unmapped_sections,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"  wrote {OUT_PATH.relative_to(ROOT)} — {len(rows)} ACs across {len(yaml_units)} units")
    print(f"  yaml_unsupported (AC tokens not in BRD section): {len(yaml_unsupported)}")
    print(f"  brd_uncovered (spec sentence with no matching AC): {len(brd_uncovered)}")
    print(f"  unmapped_sections (YAML section_id not in BRD):    {len(unmapped_sections)}")
    if yaml_unsupported:
        print()
        print("  first few yaml_unsupported (potential hallucinated ACs):")
        for g in yaml_unsupported[:5]:
            print(f"    {g['unit_id']}/{g['ac_id']} (§{g['section']}): {g['statement'][:90]}")
    if brd_uncovered:
        print()
        print("  first few brd_uncovered (potential missing ACs):")
        for g in brd_uncovered[:5]:
            print(f"    {g['unit_id']} §{g['section']}: {g['sentence'][:90]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
