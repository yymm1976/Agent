export type CompactDirection = 'base' | 'partial' | 'up_to';

export class CompactPromptEngine {
  private readonly defaultDirection: CompactDirection;

  constructor(defaultDirection: CompactDirection = 'base') {
    this.defaultDirection = defaultDirection;
  }

  getDefaultDirection(): CompactDirection {
    return this.defaultDirection;
  }

  getPrompt(direction?: CompactDirection, customInstructions?: string): string {
    const dir = direction ?? this.defaultDirection;
    const preamble = this.getNoToolsPreamble();
    const template = this.getTemplate(dir);
    const trailer = this.getNoToolsTrailer();

    let prompt = preamble + template;
    if (customInstructions?.trim()) {
      prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
    }
    prompt += trailer;
    return prompt;
  }

  formatSummary(rawSummary: string): string {
    let formatted = rawSummary;
    formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
    const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
    if (summaryMatch) {
      const content = summaryMatch[1] || '';
      formatted = formatted.replace(
        /<summary>[\s\S]*?<\/summary>/,
        `Summary:\n${content.trim()}`,
      );
    }
    formatted = formatted.replace(/\n\n+/g, '\n\n');
    return formatted.trim();
  }

  private getNoToolsPreamble(): string {
    return `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;
  }

  private getNoToolsTrailer(): string {
    return `

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;
  }

  private getTemplate(direction: CompactDirection): string {
    switch (direction) {
      case 'base': return this.getBaseTemplate();
      case 'partial': return this.getPartialTemplate();
      case 'up_to': return this.getUpToTemplate();
    }
  }

  private getBaseTemplate(): string {
    return `Your task is to create a detailed summary of the conversation so far.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts.

Your summary should include the following sections:
1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created.
4. Errors and fixes: List all errors that you ran into, and how you fixed them.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step that you will take that is related to the most recent work.

<example>
<analysis>[Your thought process]</analysis>
<summary>
1. Primary Request and Intent: [Detailed description]
2. Key Technical Concepts: [Concepts]
3. Files and Code Sections: [Files and code]
4. Errors and fixes: [Errors and fixes]
5. Problem Solving: [Description]
6. All user messages: [Messages]
7. Pending Tasks: [Tasks]
8. Current Work: [Description]
9. Optional Next Step: [Next step]
</summary>
</example>`;
  }

  private getPartialTemplate(): string {
    return `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized.

Before providing your final summary, wrap your analysis in <analysis> tags.

Your summary should include:
1. Primary Request and Intent from recent messages
2. Key Technical Concepts discussed recently
3. Files and Code Sections examined, modified, or created
4. Errors and fixes encountered
5. Problem Solving efforts
6. All user messages from the recent portion
7. Pending Tasks from recent messages
8. Current Work being done
9. Optional Next Step related to most recent work`;
  }

  private getUpToTemplate(): string {
    return `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages will follow after your summary.

Before providing your final summary, wrap your analysis in <analysis> tags.

Your summary should include:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Work Completed
9. Context for Continuing Work: Summarize any context, decisions, or state needed to continue the work`;
  }
}
