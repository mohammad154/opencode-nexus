export function pythonSteps() {
  return [
    { id: "test", command: "pytest", args: [] },
    { id: "lint", command: "ruff", args: ["check", "."] },
    { id: "typecheck", command: "mypy", args: ["."] },
  ];
}
