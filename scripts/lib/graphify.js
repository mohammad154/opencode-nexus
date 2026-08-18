/**
 * Nexus' narrow integration boundary with Graphify.
 *
 * Graphify owns extraction, persistence, refresh, and query semantics. This
 * module only resolves Graphify's native output, validates the evidence needed
 * by Nexus gates, maps repository files to Graphify nodes, and performs the
 * reverse walk needed by the legacy blast-report schema.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const GRAPHIFY_RELATIONS = Object.freeze([
  "imports",
  "imports_from",
  "calls",
  "indirect_call",
  "references",
  "re_exports",
  "inherits",
  "extends",
  "implements",
  "uses",
  "mixes_in",
  "embeds",
  "requires",
]);

const GRAPHIFY_RELATION_SET = new Set(GRAPHIFY_RELATIONS);
const UNKNOWN_HEAD = "unknown";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function slashPath(value) {
  return String(value).replace(/\\/g, "/");
}

/** Return a safe worktree-relative path, or null for an invalid path. */
export function normalizeGraphifyFile(value, worktree = process.cwd()) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = slashPath(value.trim());
  const root = path.resolve(worktree);
  let relative;
  if (path.isAbsolute(raw)) {
    relative = slashPath(path.relative(root, path.resolve(raw)));
  } else {
    relative = raw.replace(/^\.\//, "");
  }
  if (
    !relative ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("/../") ||
    relative.startsWith("/") ||
    /^[A-Za-z]:\//.test(relative)
  ) {
    return null;
  }
  return relative;
}

export function resolveGraphifyOut(worktree = process.cwd(), override = undefined) {
  const configured = override ?? process.env.GRAPHIFY_OUT ?? "graphify-out";
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(worktree, configured);
}

export function resolveGraphifyGraphPath(worktree = process.cwd(), override = undefined) {
  return path.join(resolveGraphifyOut(worktree, override), "graph.json");
}

/**
 * A graph path is canonical only when it is exactly the Graphify output the
 * current worktree owns: <worktree>/<GRAPHIFY_OUT|graphify-out>/graph.json.
 * Trusted workflow decisions must never bind to a caller-selected custom path,
 * because a foreign graph.json could otherwise satisfy safety gates.
 */
export function isCanonicalGraphifyGraphPath(
  graphPath,
  worktree = process.cwd(),
  override = undefined,
) {
  if (typeof graphPath !== "string" || graphPath.trim() === "") return false;
  return path.resolve(graphPath) === resolveGraphifyGraphPath(worktree, override);
}

function currentHead(worktree) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  return result.status === 0
    ? String(result.stdout || "").trim() || UNKNOWN_HEAD
    : UNKNOWN_HEAD;
}

function parseJsonFile(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function graphRootFromOutput(outDirectory) {
  const marker = path.join(outDirectory, ".graphify_root");
  if (!fs.existsSync(marker)) return null;
  try {
    const value = fs.readFileSync(marker, "utf8").trim();
    return value ? path.resolve(value) : null;
  } catch {
    return null;
  }
}

function manifestSourcePath(value, worktree) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(worktree, value);
}

/**
 * Validate Graphify freshness without inventing a Nexus graph fingerprint.
 * Graphify's built_at_commit and native manifest are the available evidence.
 *
 * Provenance is mandatory for a FRESH verdict: the graph must carry a
 * commit-matched built_at_commit, and BOTH the .graphify_root marker (pointing
 * at the current worktree) and a valid manifest.json must be present. Absent
 * provenance is treated as STALE so a hand-crafted graph.json that merely
 * copies the current HEAD cannot appear fresh.
 */
export function validateGraphifyFreshness({
  graph,
  worktree = process.cwd(),
  outDirectory = resolveGraphifyOut(worktree),
  requireProvenance = true,
} = {}) {
  const issues = [];
  const checks = {
    commit_match: null,
    manifest_match: null,
    root_match: null,
  };
  const current = currentHead(worktree);
  const built = graph?.built_at_commit ?? graph?.commit ?? graph?.meta?.built_at_commit;

  if (!built || built === UNKNOWN_HEAD) {
    issues.push("Graphify built_at_commit is missing or unknown");
  } else if (current === UNKNOWN_HEAD) {
    issues.push("current git HEAD is unavailable");
  } else if (built !== current) {
    issues.push(`Graphify graph is stale: built_at_commit=${built}, current=${current}`);
  }
  checks.commit_match = Boolean(
    built && built !== UNKNOWN_HEAD && current !== UNKNOWN_HEAD && built === current,
  );

  const graphRoot = graphRootFromOutput(outDirectory);
  if (graphRoot) {
    checks.root_match = graphRoot === path.resolve(worktree);
    if (!checks.root_match) {
      issues.push(`Graphify root mismatch: ${graphRoot}`);
    }
  } else {
    checks.root_match = false;
    if (requireProvenance) {
      issues.push(
        `Graphify provenance missing: no .graphify_root in ${outDirectory} proving this graph belongs to ${path.resolve(worktree)}`,
      );
    }
  }

  const needsUpdate = path.join(outDirectory, "needs_update");
  if (fs.existsSync(needsUpdate)) {
    issues.push("Graphify marked the graph as needing an update");
  }

  const manifestPath = path.join(outDirectory, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const parsed = parseJsonFile(manifestPath);
    if (!asObject(parsed.value)) {
      issues.push(`Graphify manifest is invalid: ${parsed.error?.message || "not an object"}`);
      checks.manifest_match = false;
    } else {
      checks.manifest_match = true;
      for (const [source, record] of Object.entries(parsed.value)) {
        const sourcePath = manifestSourcePath(source, worktree);
        if (!sourcePath || !asObject(record)) {
          checks.manifest_match = false;
          issues.push(`Graphify manifest entry is invalid: ${source}`);
          continue;
        }
        if (!fs.existsSync(sourcePath)) {
          checks.manifest_match = false;
          issues.push(`Graphify source is missing: ${source}`);
          continue;
        }
        if (typeof record.mtime === "number") {
          const currentMtime = fs.statSync(sourcePath).mtimeMs / 1000;
          // Filesystems and JSON serialization commonly round mtimes to ms.
          if (currentMtime > record.mtime + 0.002) {
            checks.manifest_match = false;
            issues.push(`Graphify source changed after refresh: ${source}`);
          }
        }
      }
    }
  } else {
    checks.manifest_match = false;
    if (requireProvenance) {
      issues.push(
        `Graphify provenance missing: no manifest.json in ${outDirectory}`,
      );
    }
  }

  return {
    valid: issues.length === 0,
    status: issues.length === 0 ? "FRESH" : "STALE",
    reasons: [...new Set(issues)],
    built_at_commit: built || null,
    current_head: current,
    ...checks,
  };
}

function nodeId(node) {
  if (!asObject(node)) return null;
  const value = node.id ?? node.name;
  return value === undefined || value === null || String(value) === ""
    ? null
    : String(value);
}

function edgeEndpoint(edge, key) {
  const value = edge?.[key];
  return value === undefined || value === null || String(value) === ""
    ? null
    : String(value);
}

function normalizeNode(node, worktree) {
  const id = nodeId(node);
  return {
    ...node,
    id,
    source_file: normalizeGraphifyFile(node.source_file, worktree),
  };
}

function normalizeEdge(edge) {
  return {
    ...edge,
    source: edgeEndpoint(edge, "source"),
    target: edgeEndpoint(edge, "target"),
    relation: typeof edge.relation === "string" ? edge.relation.trim().toLowerCase() : "",
  };
}

/**
 * Parse both Graphify node-link spellings (links and raw edges). The returned
 * indexes are deliberately plain JS data so callers can use them without
 * importing Graphify's Python implementation.
 */
export function parseGraphifyGraph(raw, { worktree = process.cwd(), outDirectory } = {}) {
  const issues = [];
  const graph = asObject(raw);
  if (!graph) {
    return {
      ok: false,
      status: "MALFORMED",
      issues: ["Graphify graph is not a JSON object"],
      graph: null,
      nodes: [],
      edges: [],
      nodeById: new Map(),
      fileToNodes: new Map(),
      reverse: new Map(),
    };
  }

  if (!Array.isArray(graph.nodes)) issues.push("Graphify graph.nodes is missing or invalid");
  const linkKey = Array.isArray(graph.links)
    ? "links"
    : Array.isArray(graph.edges)
      ? "edges"
      : null;
  if (!linkKey) issues.push("Graphify graph.links/edges is missing or invalid");
  if (graph.directed !== true) issues.push("Graphify graph is not directed");

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.map((node) => normalizeNode(node, worktree)) : [];
  const nodeById = new Map();
  for (const node of nodes) {
    if (!node.id) {
      issues.push("Graphify node is missing an id");
      continue;
    }
    if (nodeById.has(node.id)) issues.push(`Graphify node id is duplicated: ${node.id}`);
    nodeById.set(node.id, node);
  }

  const edges = linkKey
    ? graph[linkKey].map((edge) => normalizeEdge(edge))
    : [];
  for (const edge of edges) {
    if (!edge.source || !edge.target) {
      issues.push("Graphify edge is missing source or target");
      continue;
    }
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      issues.push(`Graphify edge references an unknown node: ${edge.source} -> ${edge.target}`);
    }
  }

  const fileToNodes = new Map();
  for (const node of nodes) {
    if (!node.source_file) continue;
    if (!fileToNodes.has(node.source_file)) fileToNodes.set(node.source_file, []);
    fileToNodes.get(node.source_file).push(node.id);
  }

  const reverse = new Map();
  for (const edge of edges) {
    if (!edge.source || !edge.target || !nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    if (!GRAPHIFY_RELATION_SET.has(edge.relation)) continue;
    if (!reverse.has(edge.target)) reverse.set(edge.target, []);
    reverse.get(edge.target).push(edge);
  }

  const structural = issues.filter((issue) => !issue.includes("not directed"));
  const status = structural.length > 0
    ? "MALFORMED"
    : graph.directed === true
      ? "FRESH"
      : "UNDIRECTED";
  return {
    ok: issues.length === 0,
    status,
    issues: [...new Set(issues)],
    graph,
    nodes,
    edges,
    nodeById,
    fileToNodes,
    reverse,
    directed: graph.directed === true,
    link_key: linkKey,
    out_directory: outDirectory || null,
  };
}

export function readGraphifyGraph({
  worktree = process.cwd(),
  graphPath = resolveGraphifyGraphPath(worktree),
  outDirectory = path.dirname(graphPath),
  graphifyOut = undefined,
} = {}) {
  const canonical = isCanonicalGraphifyGraphPath(graphPath, worktree, graphifyOut);
  if (!fs.existsSync(graphPath)) {
    return {
      ok: false,
      status: "MISSING",
      issues: [`Graphify graph is missing: ${graphPath}`],
      path: graphPath,
      out_directory: outDirectory,
      canonical,
      graph: null,
      nodes: [],
      edges: [],
      nodeById: new Map(),
      fileToNodes: new Map(),
      reverse: new Map(),
      freshness: {
        valid: false,
        status: "MISSING",
        reasons: ["Graphify graph is missing"],
      },
    };
  }
  const parsed = parseJsonFile(graphPath);
  if (parsed.error) {
    return {
      ok: false,
      status: "MALFORMED",
      issues: [`Graphify graph JSON is invalid: ${parsed.error.message || String(parsed.error)}`],
      path: graphPath,
      out_directory: outDirectory,
      canonical,
      graph: null,
      nodes: [],
      edges: [],
      nodeById: new Map(),
      fileToNodes: new Map(),
      reverse: new Map(),
      freshness: {
        valid: false,
        status: "MALFORMED",
        reasons: ["Graphify graph JSON is invalid"],
      },
    };
  }

  const parsedGraph = parseGraphifyGraph(parsed.value, { worktree, outDirectory });
  const freshness = validateGraphifyFreshness({
    graph: parsed.value,
    worktree,
    outDirectory,
  });
  const provenanceIssues = canonical
    ? []
    : [
        `Graphify graph path is not canonical: ${graphPath} (trusted decisions require ${resolveGraphifyGraphPath(worktree, graphifyOut)})`,
      ];
  const issues = [...parsedGraph.issues, ...freshness.reasons, ...provenanceIssues];
  const status = parsedGraph.status === "MALFORMED"
    ? "MALFORMED"
    : parsedGraph.status === "UNDIRECTED"
      ? "UNDIRECTED"
      : !canonical
        ? "NON_CANONICAL"
        : freshness.valid
          ? "FRESH"
          : "STALE";
  return {
    ...parsedGraph,
    ok: issues.length === 0,
    status,
    issues: [...new Set(issues)],
    path: graphPath,
    out_directory: outDirectory,
    canonical,
    freshness: {
      ...freshness,
      status: status === "FRESH" ? "FRESH" : status,
      valid:
        status === "FRESH" &&
        canonical &&
        freshness.valid &&
        parsedGraph.issues.length === 0,
      reasons: [...new Set(issues)],
    },
  };
}

/** Invoke Graphify's native refresh command. */
export function refreshGraphifyGraph({
  worktree = process.cwd(),
  graphPath = resolveGraphifyGraphPath(worktree),
  force = false,
  timeout = 120000,
  command = "graphify",
  env = process.env,
} = {}) {
  const outDirectory = path.dirname(graphPath);
  const existed = fs.existsSync(graphPath);
  const args = existed
    ? ["update", ".", ...(force ? ["--force"] : [])]
    : ["extract", ".", "--code-only", "--directed", "--no-viz"];
  const result = spawnSync(command, args, {
    cwd: worktree,
    encoding: "utf8",
    timeout,
    env: { ...env },
  });
  const unavailable = result.error?.code === "ENOENT";
  return {
    ok: result.status === 0 && !result.error,
    attempted: true,
    existed,
    command: [command, ...args],
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    status_code: result.status,
    error_code: unavailable
      ? "GRAPHIFY_UNAVAILABLE"
      : result.error?.code || null,
    error: unavailable
      ? "Graphify is required but the `graphify` executable is unavailable. Install Graphify with OpenCode, then retry."
      : result.error?.message || null,
    graph_path: graphPath,
    out_directory: outDirectory,
  };
}

export function prepareGraphifyGraph(options = {}) {
  const worktree = options.worktree || process.cwd();
  const graphPath = options.graphPath || resolveGraphifyGraphPath(worktree, options.graphifyOut);
  const refresh = refreshGraphifyGraph({ ...options, worktree, graphPath });
  const loaded = readGraphifyGraph({
    worktree,
    graphPath,
    outDirectory: path.dirname(graphPath),
    graphifyOut: options.graphifyOut,
  });
  return {
    ...loaded,
    refresh,
    ok: refresh.ok && loaded.ok,
    issues: [
      ...(refresh.ok ? [] : [
        refresh.error || refresh.stderr || "Graphify refresh failed",
      ]),
      ...loaded.issues,
    ].filter(Boolean),
    status: !refresh.ok ? "REFRESH_FAILED" : loaded.status,
    freshness: !refresh.ok
      ? {
        ...loaded.freshness,
        valid: false,
        status: "REFRESH_FAILED",
        reasons: [
          refresh.error || refresh.stderr || "Graphify refresh failed",
          ...(loaded.freshness?.reasons || []),
        ],
      }
      : loaded.freshness,
  };
}

export function mapFilesToGraphifyNodes(snapshot, files, worktree = process.cwd()) {
  const normalized = [...new Set((files || [])
    .map((file) => normalizeGraphifyFile(file, worktree))
    .filter(Boolean))];
  const mapped = [];
  const unmapped = [];
  for (const file of normalized) {
    const nodeIds = snapshot?.fileToNodes?.get(file) || [];
    if (nodeIds.length === 0) unmapped.push(file);
    else mapped.push({ file, node_ids: [...new Set(nodeIds)] });
  }
  return { files: normalized, mapped, unmapped };
}

export function reverseTraverseGraphify(snapshot, files, { worktree = process.cwd(), depth = 2 } = {}) {
  const mapping = mapFilesToGraphifyNodes(snapshot, files, worktree);
  const queue = [];
  const seen = new Set();
  for (const item of mapping.mapped) {
    for (const nodeId of item.node_ids) {
      queue.push({ node_id: nodeId, file: item.file, depth: 0, via: [item.file] });
    }
  }
  const impacts = [];
  const traversed = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const visitKey = `${current.node_id}:${current.depth}`;
    if (seen.has(visitKey)) continue;
    seen.add(visitKey);
    if (current.depth >= Math.max(0, Number(depth) || 0)) continue;
    for (const edge of snapshot?.reverse?.get(current.node_id) || []) {
      const sourceNode = snapshot.nodeById.get(edge.source);
      if (!sourceNode) continue;
      const sourceFile = sourceNode.source_file;
      if (!sourceFile) continue;
      const nextDepth = current.depth + 1;
      if (current.via.includes(sourceFile)) continue;
      const via = [...current.via, sourceFile];
      traversed.push({
        from: current.file,
        to: sourceFile,
        depth: nextDepth,
        relation: edge.relation,
      });
      const existing = impacts.find((impact) => impact.file === sourceFile);
      if (!existing || nextDepth < existing.depth) {
        const impact = {
          file: sourceFile,
          depth: nextDepth,
          via,
          direct: current.depth === 0,
          relation: edge.relation,
        };
        if (existing) Object.assign(existing, impact);
        else impacts.push(impact);
      }
      if (nextDepth < Math.max(0, Number(depth) || 0)) {
        queue.push({
          node_id: edge.source,
          file: sourceFile,
          depth: nextDepth,
          via,
        });
      }
    }
  }
  impacts.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  traversed.sort((a, b) => a.depth - b.depth || a.to.localeCompare(b.to) || a.from.localeCompare(b.from));
  return {
    mapping,
    impacts,
    edges: traversed,
    start_nodes: mapping.mapped.flatMap((item) => item.node_ids),
  };
}
