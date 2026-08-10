import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Skill file content. Loaded from the bundled skills/ directory. */
function loadSkillContent(): string {
  // Try multiple locations: package root, dist parent, dist
  const candidates = [
    join(process.cwd(), "skills", "tdai-memory", "SKILL.md"),
    join(__dirname, "..", "skills", "tdai-memory", "SKILL.md"),
    join(__dirname, "skills", "tdai-memory", "SKILL.md"),
  ];

  for (const path of candidates) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      // Try the next candidate
    }
  }

  throw new Error(
    "Could not find skills/tdai-memory/SKILL.md. Make sure the package includes the skills directory.",
  );
}

/** Supported agent skill directories. */
const SKILL_TARGETS = [
  {
    name: "Devin CLI",
    path: join(homedir(), ".config", "devin", "skills", "tdai-memory", "SKILL.md"),
  },
  {
    name: "Claude Code",
    path: join(homedir(), ".claude", "skills", "tdai-memory", "SKILL.md"),
  },
  {
    name: "Generic (.agents)",
    path: join(homedir(), ".agents", "skills", "tdai-memory", "SKILL.md"),
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
