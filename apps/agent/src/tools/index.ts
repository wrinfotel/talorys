import { MCP_TOOL_PREFIX } from "@talorys/shared";
import type { ToolDefinition } from "./registry";
import { taskTools } from "./tasks";
import { noteTools, projectTools } from "./notes";
import { memoryTools } from "./memories";
import { reminderTools } from "./reminders";
import { searchTools } from "./search";
import { planTools } from "./plans";
import { webTools } from "./web";

/**
 * Every tool available to the agent. To add a capability, create a module with
 * `defineTool(...)` entries and add it here. Tools may only touch the owner's
 * own data through the service layer: no shell, code execution or credentials.
 * The built-in web tools are the one network exception: read-only, public
 * http(s) URLs only, no logins.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...taskTools,
  ...planTools,
  ...noteTools,
  ...projectTools,
  ...memoryTools,
  ...reminderTools,
  ...searchTools,
  ...webTools,
] as ToolDefinition[];

const names = new Set<string>();
for (const t of ALL_TOOLS) {
  if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
  // The prefix is reserved for remote MCP tools, so they can never take a built-in tool's name.
  if (t.name.startsWith(MCP_TOOL_PREFIX)) throw new Error(`Built-in tool names can't start with ${MCP_TOOL_PREFIX}: ${t.name}`);
  names.add(t.name);
}

export { runApprovedAction, ToolExecutor, ToolError, type ToolContext, type ToolDefinition } from "./registry";
