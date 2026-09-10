export function rustSteps() {
  return [
    { id: "test", command: "cargo", args: ["test"] },
    { id: "check", command: "cargo", args: ["check"] },
    { id: "lint", command: "cargo", args: ["clippy"] },
  ];
}
