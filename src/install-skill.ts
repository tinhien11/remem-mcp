import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Skill file content. Loaded from the bundled skills/ directory. */
function loadSkillContent(): string {
  // Try multiple locations: package root, dist parent, dist
  const candidates = [
    join(process.cwd(), "skills", "remem-mcp", "SKILL.md"),
    join(__dirname, "..", "skills", "remem-mcp", "SKILL.md"),
    join(__dirname, "skills", "remem-mcp", "SKILL.md"),
  ];

  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      // Try the next candidate
    }
  }

  throw new Error(
    "Could not find skills/remem-mcp/SKILL.md. Make sure the package includes the skills directory.",
  );
}

/** Supported agent skill directories. */
const SKILL_TARGETS = [
  {
    name: "Devin CLI",
    path: join(homedir(), ".config", "devin", "skills", "remem-mcp", "SKILL.md"),
  },
  {
    name: "Claude Code",
    path: join(homedir(), ".claude", "skills", "remem-mcp", "SKILL.md"),
  },
  {
    name: "Codex CLI",
    path: join(homedir(), ".codex", "skills", "remem-mcp", "SKILL.md"),
  },
  {
    name: "Generic (.agents)",
    path: join(homedir(), ".agents", "skills", "remem-mcp", "SKILL.md"),
  },
];

/** Install the skill file to all supported agent directories. */
export async function installSkill(): Promise<void> {
  const skillContent = loadSkillContent();
  let installed = 0;

  for (const target of SKILL_TARGETS) {
    const dir = dirname(target.path);

    // Create the directory if it does not exist
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Check if the skill already exists
    if (existsSync(target.path)) {
      console.log(`  ${target.name}: Already installed. Updated.`);
    } else {
      console.log(`  ${target.name}: Installed.`);
    }

    writeFileSync(target.path, skillContent, "utf-8");
    installed++;
  }

  console.log(`\nSkill installed to ${installed} location(s).`);
  console.log("Restart your agent to load the skill.");
  console.log("\nThe skill teaches your agent to:");
  console.log("  - Recall past context before answering");
  console.log("  - Capture decisions, learnings, and fixes after completing work");
  console.log("  - Search with filters when recall is too broad");
  console.log("  - Forget only on explicit user request");
}
