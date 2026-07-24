import { createProject, type Project } from "./projects";

/**
 * Starter Templates (ticket 08): one-click starting points on the home screen so
 * a Sandbox User is never faced with a blank chat. Each seeds a Project and a
 * first prompt, dropping the user into a session already primed for the task.
 */
export type TemplateCapability = "upload" | "preview";

export interface StarterTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Default Project name if the user doesn't rename it. */
  readonly defaultProjectName: string;
  /** The first prompt fed to Claude when the session opens. */
  readonly seedPrompt: string;
  /** Launcher features this template shines with (enhances, not requires). */
  readonly needs?: readonly TemplateCapability[];
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: "personal-webpage",
    title: "Build a personal webpage",
    description: "Make a simple webpage about yourself and preview it in your browser.",
    defaultProjectName: "My Webpage",
    seedPrompt:
      "Help me build a simple, good-looking personal webpage about myself. " +
      "Create an index.html, then serve it so I can click Preview to see it.",
    needs: ["preview"],
  },
  {
    id: "guessing-game",
    title: "Make a guessing game",
    description: "Build a little number-guessing game and play it right here in the chat.",
    defaultProjectName: "Guessing Game",
    seedPrompt:
      "Help me build a fun number-guessing game I can run and play in the terminal. " +
      "Write it in Python, then run it so I can try it.",
  },
  {
    id: "analyze-spreadsheet",
    title: "Analyze a spreadsheet I upload",
    description: "Upload a CSV or spreadsheet and have Claude find the interesting bits.",
    defaultProjectName: "Spreadsheet Analysis",
    seedPrompt:
      "I'm going to upload a spreadsheet (CSV). Once it's here, read it, summarise " +
      "what's in it, and point out anything interesting or surprising. " +
      "Anonymise any personal or identifying data before showing it back to me.",
    needs: ["upload"],
  },
];

export function templateById(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}

export interface InstantiatedTemplate {
  readonly project: Project;
  readonly seedPrompt: string;
}

/**
 * Create a Project from a template and seed its first prompt. The returned
 * seedPrompt is what the Launcher feeds to the opening Claude session.
 */
export function instantiateTemplate(
  workspaceDir: string,
  templateId: string,
  projectName?: string,
): InstantiatedTemplate {
  const template = templateById(templateId);
  if (!template) {
    throw new Error(`Unknown Starter Template: '${templateId}'.`);
  }
  const project = createProject(workspaceDir, projectName ?? template.defaultProjectName, {
    seedPrompt: template.seedPrompt,
  });
  return { project, seedPrompt: template.seedPrompt };
}
