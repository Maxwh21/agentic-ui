// The one file you edit to build your own workspace: who the agents are, what each may touch,
// which outside services they reach, and which actions need a human to sign them off.
// The example below is a tiny "notes desk": you talk to an assistant, it hands writing to a worker,
// and a note is only published after you approve it on a card.
module.exports = {
  // The agent you talk to in the rail. Every other agent is a worker it (or the app) hands jobs to.
  main: 'assistant',
  maxParallel: 3, // workers running at once (the main agent never waits for a slot)

  agents: {
    assistant: {
      label: 'Assistant', icon: 'sparkle', model: 'sonnet', prompt: 'prompts/assistant.md', memory: true,
      // Claude Code's own tools this agent may use. Anything not listed is refused by the policy hook.
      tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      // The app's own tools (see src/tools.js and `tools` below).
      appTools: ['remember', 'forget', 'ask_agent', 'agent_result', 'name_thread', 'show_panel', 'propose_action', 'list_actions', 'show_actions', 'list_channels'],
    },
    writer: {
      label: 'Writer', icon: 'pen', worker: true, model: 'haiku', prompt: 'prompts/writer.md', memory: true,
      tools: [],
      appTools: ['remember', 'forget', 'propose_action', 'list_actions', 'list_channels'],
    },
    // An executor: the app starts it only to carry out one approved action, and the gate checks its one call.
    publisher: {
      label: 'Publisher', icon: 'bolt', executor: true, model: 'haiku', prompt: 'prompts/publisher.md',
      tools: ['mcp__notes__publish_note'],
      appTools: [],
    },
  },

  // Outside services, as MCP servers. In demo mode the `mock` version runs instead, under the same name,
  // so the tools, the policy and the gate all work the same but nothing real happens.
  services: {
    notes: {
      command: 'node', args: ['examples/notes-service.js'],
      mock: { command: 'node', args: ['examples/notes-service.js', '--mock'] },
    },
  },

  // Gated actions. An agent proposes one, you approve it on a card, and only then does the executor run.
  // The gate (src/gates.js) checks the executor's tool call against what you approved, character for character.
  actions: {
    publish_note: {
      label: 'Note',
      fields: { channel: 'Channel', title: 'Title', body: 'Body' }, // what the action holds, shown on the card
      required: ['channel', 'title', 'body'],
      executor: 'publisher',
      tool: 'mcp__notes__publish_note', // the one outside call this action may make
      match: { channel: 'channel', title: 'title', body: 'body' }, // tool argument -> action field, compared exactly
      window: { start: '08:00', end: '20:00', days: [1, 2, 3, 4, 5], timeZone: 'Europe/London' }, // when it may run
      rate: { perDay: 20, gapMinutes: 2 }, // how many a day, and how far apart
      blocklist: 'channel', // refuse an action whose channel is on the blocklist
      outcome: (text) => (/"status"\s*:\s*"published"/.test(text) ? 'done' : 'failed'), // read the service's answer
    },
  },

  // Your own app tools. Each gets the run context and the arguments; whatever it returns goes back to the agent.
  tools: {
    list_channels: {
      description: 'List the channels a note can be published to.',
      input: {},
      handler: () => ({ channels: ['#team', '#announcements', '#random'] }),
    },
  },

  // What the agent is told about the page you are on (sent with every message), and starter prompts for it.
  page(hash) {
    const [, page] = String(hash || '').split('/');
    if (page === 'activity') return { label: 'Activity', line: 'You are looking at the activity log.', starters: ['What happened today?'] };
    if (page === 'notebooks') return { label: 'Notebooks', line: 'You are looking at the agents\' notebooks.', starters: ['What have you learned so far?'] };
    return { label: 'Home', line: 'You are on the home page, which lists the notes waiting, scheduled and published.',
      starters: ['Draft a short note for #team about Friday\'s demo', 'What is waiting for my approval?', 'Show me what was published this week'] };
  },

  // Demo mode: looser timing so things happen on camera, and tools to switch off.
  demo: {
    window: null, // any time of day
    gapMinutes: 0.25,
    blockTools: ['WebSearch', 'WebFetch'], // so nothing real comes in while filming
  },
};
