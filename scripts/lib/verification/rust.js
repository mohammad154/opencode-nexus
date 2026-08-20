export function rustSteps() {
  return [
    { id: "test", command: "cargo test" },
    { id: "check", command: "cargo check" },
    { id: "lint", command: "cargo clippy" },
  ];
}
