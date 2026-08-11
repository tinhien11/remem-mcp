import Database from "better-sqlite3";

interface TypeCount {
  type: string;
  count: number;
}

/** Print memory statistics: total captures, breakdown by type, top tags, sessions. */
export function stats(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });

  const total = db.prepare("SELECT COUNT(*) as count FROM captures").get() as { count: number };

  if (total.count === 0) {
    console.log("No captures found. The database is empty.");
    db.close();
    return;
  }

  console.log(`\nMemory statistics`);
  console.log(`=================`);
  console.log(`Database: ${dbPath}`);
  console.log(`Total captures: ${total.count}`);

  // Breakdown by type
  const byType = db
    .prepare("SELECT type, COUNT(*) as count FROM captures GROUP BY type ORDER BY count DESC")
    .all() as TypeCount[];

  console.log(`\nBy type:`);
  const typeBar = Math.max(...byType.map((t) => t.count));
  for (const row of byType) {
    const bar = "█".repeat(Math.round((row.count / typeBar) * 20));
    console.log(`  ${row.type.padEnd(14)} ${String(row.count).padStart(4)}  ${bar}`);
  }

  // Top tags
  const allTags = db
    .prepare("SELECT tags FROM captures WHERE tags IS NOT NULL AND tags != '[]'")
    .all() as { tags: string }[];

  const tagCounts = new Map<string, number>();
  for (const row of allTags) {
    try {
      const tags = JSON.parse(row.tags) as string[];
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (tagCounts.size > 0) {
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

    console.log(`\nTop tags:`);
    const maxCount = topTags[0][1];
    for (const [tag, count] of topTags) {
      const bar = "█".repeat(Math.round((count / maxCount) * 20));
      console.log(`  ${tag.padEnd(20)} ${String(count).padStart(4)}  ${bar}`);
    }
  }

  // Sessions
  const sessions = db
    .prepare("SELECT COUNT(DISTINCT session_key) as count FROM captures")
    .get() as { count: number };
  console.log(`\nSessions: ${sessions.count}`);

  // Agents
  const agents = db
    .prepare(
      "SELECT agent_id, COUNT(*) as count FROM captures GROUP BY agent_id ORDER BY count DESC",
    )
    .all() as TypeCount[];
  if (agents.length > 0) {
    console.log(`\nBy agent:`);
    for (const row of agents) {
      console.log(`  ${row.agent_id.padEnd(14)} ${String(row.count).padStart(4)}`);
    }
  }

  // Date range
  const range = db
    .prepare("SELECT MIN(created_at) as min, MAX(created_at) as max FROM captures")
    .get() as { min: number; max: number };

  if (range.min && range.max) {
    const minDate = new Date(range.min).toISOString().split("T")[0];
    const maxDate = new Date(range.max).toISOString().split("T")[0];
    console.log(`\nDate range: ${minDate} to ${maxDate}`);
  }

  // L0 vs L1
  const l0 = db.prepare("SELECT COUNT(*) as count FROM captures WHERE type != 'atom'").get() as {
    count: number;
  };
  const l1 = db.prepare("SELECT COUNT(*) as count FROM captures WHERE type = 'atom'").get() as {
    count: number;
  };

  if (l1.count > 0) {
    console.log(`\nLayer breakdown:`);
    console.log(`  L0 (raw):     ${String(l0.count).padStart(4)}`);
    console.log(`  L1 (atoms):   ${String(l1.count).padStart(4)}`);
  }

  // L1 atoms table (populated by pipeline)
  try {
    const atomsCount = db.prepare("SELECT COUNT(*) as count FROM atoms").get() as { count: number };
    if (atomsCount.count > 0) {
      console.log(`  L1 (atoms table): ${String(atomsCount.count).padStart(4)}`);
    }
  } catch {
    // atoms table may not exist in old databases
  }

  // L2 scenarios
  try {
    const scenariosCount = db.prepare("SELECT COUNT(*) as count FROM scenarios").get() as {
      count: number;
    };
    if (scenariosCount.count > 0) {
      console.log(`  L2 (scenarios):   ${String(scenariosCount.count).padStart(4)}`);
    }
  } catch {
    // scenarios table may not exist in old databases
  }

  // Messages
  try {
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages").get() as {
      count: number;
    };
    if (msgCount.count > 0) {
      console.log(`\nMessages: ${msgCount.count}`);
    }
  } catch {
    // messages table may not exist in old databases
  }

  // Multi-tenant: teams
  try {
    const teamsCount = db
      .prepare("SELECT COUNT(DISTINCT team_id) as count FROM captures WHERE team_id IS NOT NULL")
      .get() as { count: number };
    if (teamsCount.count > 0) {
      console.log(`\nTeams: ${teamsCount.count}`);
      const teamBreakdown = db
        .prepare(
          "SELECT team_id, COUNT(*) as count FROM captures WHERE team_id IS NOT NULL GROUP BY team_id ORDER BY count DESC",
        )
        .all() as TypeCount[];
      for (const row of teamBreakdown) {
        console.log(`  ${row.team_id.padEnd(20)} ${String(row.count).padStart(4)}`);
      }
    }
  } catch {
    // team_id column may not exist in old databases
  }

  // Knowledge assets
  try {
    const knowledgeCount = db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as {
      count: number;
    };
    if (knowledgeCount.count > 0) {
      console.log(`\nKnowledge assets: ${knowledgeCount.count}`);
    }
  } catch {
    // knowledge table may not exist in old databases
  }

  // Skills
  try {
    const skillsCount = db.prepare("SELECT COUNT(*) as count FROM skills").get() as {
      count: number;
    };
    if (skillsCount.count > 0) {
      console.log(`Skills: ${skillsCount.count}`);
    }
  } catch {
    // skills table may not exist in old databases
  }

  console.log("");
  db.close();
}
