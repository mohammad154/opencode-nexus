/** Node verification adapter hints */
export function nodeSteps(scripts = {}) {
  const steps = [];
  if (scripts.test) steps.push({ id: "test", command: "npm", args: ["test"] });
  if (scripts.lint) steps.push({ id: "lint", command: "npm", args: ["run", "lint"] });
  if (scripts.typecheck) {
    steps.push({ id: "typecheck", command: "npm", args: ["run", "typecheck"] });
  }
  if (scripts.build) steps.push({ id: "build", command: "npm", args: ["run", "build"] });
  return steps;
}
