export function goSteps() {
  return [
    { id: "test", command: "go", args: ["test", "./..."] },
    { id: "vet", command: "go", args: ["vet", "./..."] },
  ];
}
