"""WP4/m2: safe-metadata activity stream + signed ledger checkpoint anchors.

Hard redlines (AGENTS.md §4 / plan m2):
- activity_events holds metadata only — no payload/content/params_hash/digest.
- activity_checkpoints anchors the worker's signed ledger head (seq/hash/
  count + EIP-191 signature), never ledger content.
"""
