"""Canonical identity normalization and Unicode casefold candidate expansion.

Provides centralized helpers for:
- Canonical identity normalization (canonical_identity)
- Slug generation (canonical_slug) matching chat delivery and WS channels
- Deterministic index-backed casefold candidate expansion (expand_casefold_candidates)
  for sub-millisecond database queries without full table scans.
"""

from __future__ import annotations

import re
import unicodedata

# Bidirectional mapping between folded substrings and their Unicode alternate spellings.
# Sorted by length descending during substitution so compound ligatures (e.g. 'ffi')
# take precedence over simple sequences ('ff', 'fi').
FOLD_EXPANSIONS: dict[str, list[str]] = {
    "ss": ["ß", "ẞ"],
    "ff": ["ﬀ"],
    "fi": ["ﬁ"],
    "fl": ["ﬂ"],
    "ffi": ["ﬃ"],
    "ffl": ["ﬄ"],
    "st": ["ﬆ", "ﬅ"],
    "s": ["ſ"],
    "k": ["K"],
    "μ": ["µ"],
    "µ": ["μ"],
    "σ": ["ς"],
    "ς": ["σ"],
}


def normalize_unicode_casefold(value: str) -> str:
    """Normalize text using Unicode NFKC followed by full casefold.

    This provides complete Unicode casefold equivalence class coverage
    (including Greek theta/script theta θ/ϑ, German eszett ß/ss/ẞ, ligatures
    ﬁ/fi, ﬃ/ffi, Greek sigmas Σ/σ/ς, etc.) without relying on ad-hoc
    replacement tables.
    """
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFKC", value.strip()).casefold()


def canonical_identity(value: str) -> str:
    """Return the canonical casefolded identity for an account or agent name.

    Applies Unicode NFKC normalization followed by full Unicode case folding.
    """
    return normalize_unicode_casefold(value)


def canonical_slug(value: str) -> str:
    """Return the canonical slug identifier with whitespace collapsed to underscores.

    Matches the slug convention used in chat delivery service and WebSocket channels:
    re.sub(r"\\s+", "_", value.strip().casefold())
    """
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", "_", normalize_unicode_casefold(value))


def expand_casefold_candidates(username: str, max_candidates: int = 64) -> set[str]:
    """Generate bounded candidate representations that map to the same casefold identity.

    Covers exact, trimmed, lowercase, uppercase, titlecase, casefolded, and
    bidirectional multi-character Unicode folding variants (e.g. ss <-> ß/ẞ, s <-> ſ).

    Allows SQL queries of the form:
        SELECT * FROM users WHERE username IN (:candidates)
    to leverage the unique B-Tree index on User.username in sub-millisecond time,
    eliminating sequential scans while detecting collisions symmetrically.
    """
    if not isinstance(username, str):
        return set()

    raw = username
    stripped = username.strip()
    if not stripped:
        return {raw} if raw else set()

    cf = stripped.casefold()
    lower = stripped.lower()

    candidates: set[str] = {
        raw,
        stripped,
        lower,
        stripped.upper(),
        stripped.title(),
        cf,
        cf.upper(),
        cf.title(),
    }

    # Find which folded target substrings appear in cf
    patterns: list[tuple[str, list[str]]] = []
    for target in sorted(FOLD_EXPANSIONS.keys(), key=len, reverse=True):
        if target in cf:
            patterns.append((target, FOLD_EXPANSIONS[target]))

    current_variants = {cf, lower, stripped}
    for target, alts in patterns:
        next_variants = set(current_variants)
        for var in current_variants:
            if target in var:
                for alt in alts:
                    substituted = var.replace(target, alt)
                    next_variants.add(substituted)
                    next_variants.add(substituted.lower())
                    next_variants.add(substituted.upper())
                    next_variants.add(substituted.title())
        current_variants = next_variants
        if len(current_variants) >= max_candidates:
            break

    candidates.update(current_variants)
    return {c for c in candidates if c}
