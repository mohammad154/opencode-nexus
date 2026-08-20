export function goSteps() {
  return [
    { id: "test", command: "go test ./..." },
    { id: "vet", command: "go vet ./..." },
  ];
}
