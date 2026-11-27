"""Keep shared CSS tokens in tokens.css and prevent retired palette aliases."""

from pathlib import Path
import re

SOURCE = Path(__file__).resolve().parents[1] / "frontend/src"
TOKENS = SOURCE / "styles/tokens.css"
DECLARATION = re.compile(r"(?:^|[;{])\s*(--[\w-]+)\s*:", re.MULTILINE)
RETIRED = re.compile(
    r"(?<![\w-])--(?:legacy-[\w-]+|accent-(?:border|light|soft)|amber(?:-soft)?|"
    r"actor-human2-(?:bg|fg)|bg(?:-card|-elevated|-page|-press)?|border(?:-strong)?|"
    r"ease-exit|font|(?:fs|lh)-display|gray-(?:0|25|100|150|200|400|500|600|700|800|900)|"
    r"green(?:-border|-soft)?|mono|radius(?:-lg|-md|-pill|-sm)?|red(?:-soft)?|"
    r"shadow(?:-lg|-md|-sm)?|success(?:-bg|-border)?|surface(?:-soft)?|"
    r"text(?:-muted|-primary|-secondary)?|warning(?:-bg|-border)?)(?![\w-])"
)


def main() -> None:
    shared = set(DECLARATION.findall(TOKENS.read_text()))
    violations = []
    for path in SOURCE.rglob("*"):
        if path.suffix not in {".css", ".ts", ".tsx"}:
            continue
        contents = path.read_text()
        for match in RETIRED.finditer(contents):
            line = contents.count("\n", 0, match.start()) + 1
            violations.append(f"{path.relative_to(SOURCE)}:{line}: retired token {match[0]}")
        if path.suffix == ".css" and path != TOKENS:
            duplicate = shared.intersection(DECLARATION.findall(contents))
            if duplicate:
                violations.append(
                    f"{path.relative_to(SOURCE)}: shared tokens declared outside tokens.css: "
                    + ", ".join(sorted(duplicate))
                )
    if violations:
        raise SystemExit("\n".join(violations))
    print("Frontend token declarations are centralized and retired aliases are absent.")


if __name__ == "__main__":
    main()
