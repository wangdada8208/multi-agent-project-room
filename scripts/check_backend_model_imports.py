"""Check direct imports from Hub ORM models without importing the application."""

import ast
from collections.abc import Iterator
from importlib.util import resolve_name
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1] / "backend/app"
MODEL_INFRASTRUCTURE = (
    "app.agent.identity",
    "app.chat.pg_wakeup",
    "app.chat.plaintext_guard",
    "app.core.database",
    "app.core.timestamps",
)


def imports(tree: ast.AST, package: str) -> Iterator[tuple[int, str]]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.ImportFrom):
            module = resolve_name("." * node.level + (node.module or ""), package)
            for alias in node.names:
                yield node.lineno, f"{module}.{alias.name}"


def main() -> int:
    feature_models = sorted(APP_DIR.glob("*/models.py"))
    model_files = feature_models + sorted((APP_DIR / "models").rglob("*.py"))
    allowed = (
        "app.models",
        *MODEL_INFRASTRUCTURE,
        *(f"app.{path.parent.name}.models" for path in feature_models),
    )
    failed = False
    for path in model_files:
        relative = path.relative_to(APP_DIR)
        package = ".".join(("app", *relative.parts[:-1]))
        for line, target in imports(ast.parse(path.read_text(encoding="utf-8")), package):
            if target != "app" and not target.startswith("app."):
                continue
            if any(target == module or target.startswith(module + ".") for module in allowed):
                continue
            print(
                f"backend/app/{relative}:{line}: ORM model cannot import {target}. "
                "Keep request handling and business services outside ORM models."
            )
            failed = True
    if not failed:
        print(f"Checked imports in {len(model_files)} ORM model files.")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
