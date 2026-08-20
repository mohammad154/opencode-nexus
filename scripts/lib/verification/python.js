export function pythonSteps() {
  return [
    { id: "test", command: "pytest" },
    { id: "lint", command: "ruff check ." },
    { id: "typecheck", command: "mypy ." },
  ];
}
