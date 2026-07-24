import { createProject } from "./projects";
export const STARTER_TEMPLATES = [
    {
        id: "personal-webpage",
        title: "Build a personal webpage",
        description: "Make a simple webpage about yourself and preview it in your browser.",
        defaultProjectName: "My Webpage",
        seedPrompt: "Help me build a simple, good-looking personal webpage about myself. " +
            "Create an index.html I can preview, then start a local server on port 5173 " +
            "so I can click Preview to see it.",
        needs: ["preview"],
    },
    {
        id: "guessing-game",
        title: "Make a guessing game",
        description: "Build a little number-guessing game and play it right here in the chat.",
        defaultProjectName: "Guessing Game",
        seedPrompt: "Help me build a fun number-guessing game I can run and play in the terminal. " +
            "Write it in Python, then run it so I can try it.",
    },
    {
        id: "analyze-spreadsheet",
        title: "Analyze a spreadsheet I upload",
        description: "Upload a CSV or spreadsheet and have Claude find the interesting bits.",
        defaultProjectName: "Spreadsheet Analysis",
        seedPrompt: "I'm going to upload a spreadsheet (CSV). Once it's here, read it, summarise " +
            "what's in it, and point out anything interesting or surprising.",
        needs: ["upload"],
    },
];
export function templateById(id) {
    return STARTER_TEMPLATES.find((t) => t.id === id);
}
/**
 * Create a Project from a template and seed its first prompt. The returned
 * seedPrompt is what the Launcher feeds to the opening Claude session.
 */
export function instantiateTemplate(workspaceDir, templateId, projectName) {
    const template = templateById(templateId);
    if (!template) {
        throw new Error(`Unknown Starter Template: '${templateId}'.`);
    }
    const project = createProject(workspaceDir, projectName ?? template.defaultProjectName, {
        seedPrompt: template.seedPrompt,
    });
    return { project, seedPrompt: template.seedPrompt };
}
