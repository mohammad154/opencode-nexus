/** Node verification adapter hints */
export function nodeSteps(scripts = {}) {
  const steps = [];
  if (scripts.test) steps.push({ id: "test", command: "npm test" });
  if (scripts.lint) steps.push({ id: "lint", command: "npm run lint" });
  if (scripts.typecheck) steps.push({ id: "typecheck", command: "npm run typecheck" });
  if (scripts.build) steps.push({ id: "build", command: "npm run build" });
  return steps;
}
