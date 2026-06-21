import type { House, SortResult } from "./types.js";

/**
 * Risk keywords that map tool descriptions to houses.
 * Gryffindor: brave, creative, high-impact, experimental
 * Slytherin: destructive, dangerous, high-risk, permanent changes
 * Ravenclaw: analytical, read-only, complex logic, data processing
 * Hufflepuff: safe, routine, maintenance, low-impact
 */
const HOUSE_RULES: Record<House, { keywords: string[]; weight: number }> = {
  gryffindor: {
    keywords: [
      "create", "deploy", "launch", "init", "new", "build", "generate",
      "write", "add", "design", "experiment", "pilot", "beta",
    ],
    weight: 1,
  },
  slytherin: {
    keywords: [
      "delete", "remove", "destroy", "drop", "purge", "erase", "wipe",
      "terminate", "kill", "ban", "revoke", "shutdown", "nuke",
    ],
    weight: 2,
  },
  ravenclaw: {
    keywords: [
      "analyze", "search", "query", "read", "get", "list", "inspect",
      "examine", "calculate", "validate", "check", "diff", "log",
    ],
    weight: 1,
  },
  hufflepuff: {
    keywords: [
      "update", "edit", "patch", "fix", "modify", "set", "configure",
      "backup", "archive", "sync", "rename", "move", "copy", "format",
    ],
    weight: 1,
  },
};

const TOOL_NAME_WEIGHTS: Record<string, House> = {
  delete: "slytherin",
  destroy: "slytherin",
  terminate: "slytherin",
  create: "gryffindor",
  write: "gryffindor",
  analyze: "ravenclaw",
  search: "ravenclaw",
  update: "hufflepuff",
  edit: "hufflepuff",
  configure: "hufflepuff",
};

/**
 * Deterministically sorts a tool into a Hogwarts house based on its
 * name and description. The Sorting Hat "talks" to the user by streaming
 * rhyming reasoning via the returned reasoning field.
 */
export function sortTool(
  toolName: string,
  toolDescription: string,
  pleaseNotSlytherin: boolean = false,
): SortResult {
  const lowerName = toolName.toLowerCase();
  const lowerDesc = toolDescription.toLowerCase();

  // Check explicit tool name mapping first
  for (const [prefix, house] of Object.entries(TOOL_NAME_WEIGHTS)) {
    if (lowerName.startsWith(prefix)) {
      return buildSortResult(house, 0.85, lowerName);
    }
  }

  // Score each house based on keyword matches
  const scores: Record<House, number> = {
    gryffindor: 0,
    slytherin: 0,
    ravenclaw: 0,
    hufflepuff: 0,
  };

  for (const [house, rules] of Object.entries(HOUSE_RULES)) {
    for (const keyword of rules.keywords) {
      if (lowerName.includes(keyword) || lowerDesc.includes(keyword)) {
        scores[house as House] += 1 * rules.weight;
      }
    }
  }

  // Check description for additional context
  if (lowerDesc.includes("danger") || lowerDesc.includes("irreversible") ||
      lowerDesc.includes("permanent") || lowerDesc.includes("warning")) {
    scores.slytherin += 3;
  }

  if (lowerDesc.includes("read") || lowerDesc.includes("view") ||
      lowerDesc.includes("report") || lowerDesc.includes("stats")) {
    scores.ravenclaw += 2;
  }

  if (lowerDesc.includes("safe") || lowerDesc.includes("routine") ||
      lowerDesc.includes("simple") || lowerDesc.includes("minor")) {
    scores.hufflepuff += 2;
  }

  if (lowerDesc.includes("new") || lowerDesc.includes("innovative") ||
      lowerDesc.includes("pilot") || lowerDesc.includes("feature")) {
    scores.gryffindor += 2;
  }

  // Find the house with the highest score
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const [topHouse, topScore] = sorted[0];
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const confidence = Math.min(topScore / totalScore + 0.3, 0.98);

  let house = topHouse as House;

  // Respect the please_not_slytherin preference
  if (pleaseNotSlytherin && house === "slytherin" && sorted.length > 1) {
    house = sorted[1][0] as House;
  }

  return buildSortResult(house, confidence, lowerName);
}

function buildSortResult(house: House, confidence: number, toolName: string): SortResult {
  const rhymes: Record<House, string[]> = {
    gryffindor: [
      `A BRAVE soul wields "${toolName}" — Gryffindor claims this one!`,
      `With courage bold and spirits bright, Gryffindor takes this tool tonight!`,
    ],
    slytherin: [
      `Hmm... "${toolName}" — I sense ambition... SLYTHERIN!`,
      `The path of power calls this tool, Slytherin's domain — don't be a fool!`,
    ],
    ravenclaw: [
      `A sharp mind for "${toolName}" — RAVENCLAW is the place!`,
      `Wit beyond measure, this tool's a treasure — Ravenclaw's the rightful owner!`,
    ],
    hufflepuff: [
      `Patient and true, "${toolName}" belongs in HUFFLEPUFF with the loyal crew!`,
      `Hard work and dedication — Hufflepuff accepts this creation!`,
    ],
  };

  const options = rhymes[house];
  const reasoning = options[Math.floor(Math.random() * options.length)];

  return { house, confidence: Math.round(confidence * 100) / 100, reasoning };
}
