# Example: a customer-discovery factory

agentic-ui grew out of a tool I built for my own customer discovery. Before it, every step ran in a separate chat: research a sector, find companies, find the right person, write an email, send it by hand. I joined the steps into one pipeline that keeps its state in one database. Agents do the legwork through two connectors, **Apollo** (prospect data and sending) and **Outlook** (Microsoft 365, reading replies), and nothing goes out until I've signed it off.

This page shows what that looks like as an agentic-ui workspace. It's a pattern to copy, not code that ships in this repo.

## The pipeline

```
sector → lean canvas → companies → the right person → first email → sign-off → staggered send → replies → calls booked
```

1. **Sector and canvas.** I talk to the main agent about a sector. It researches on the web, proposes a scope and the sub-niches worth targeting, asks me a few questions, then writes a lean canvas as a markdown file. Every claim is tagged evidence (with a link) or guess. The canvas ends with "outreach-ready extras": **Apollo search criteria** (titles, keywords, industries, headcount, location, exclusions), two or three **hook arms** (different angles for the email, so you can see which one gets replies), and a handful of interview questions.
2. **Companies.** The main agent hands "find 10 companies" to a **finder** worker. The finder reads the canvas's Apollo criteria, runs Apollo's company search, enriches the promising ones (description, headcount, job postings) and checks them on the web. It proposes companies, each with a one-line reason and a source. They come back as a card in the chat, and I keep or remove each one with a button. Duplicates and do-not-contact companies are refused by the app tool, not by the prompt.
3. **People.** Keeping a company starts a **people** worker without being asked. It uses Apollo's people search to find the single best person to contact, then people-match and email validation to get a working address. Those calls spend Apollo credits, so the policy hook counts them and blocks any over a daily cap. It is told never to guess an address.
4. **Drafts.** Adding a person with an address starts an **email** worker, which drafts one first-contact email. It has no Apollo or Outlook tools at all. The format is fixed: a specific opener about their company, the question shaped by the hook arm, who I am, and a small ask. Only the hook arm varies, so the reply rates per arm mean something. One first-contact email per person, ever.
5. **Sign-off.** The main agent puts the drafts in front of me as a card. I tweak wording in chat, then approve. The app proposes a staggered schedule.
6. **Send, through Apollo.** At each slot the app starts the **send** executor. It finds or creates the Apollo contact, creates the email message, then calls send-now. Both the create call and the send call go through the gate, which turns the HTML back into text and checks recipient, subject and body against what I approved, character for character. The gate also checks the sending window, the daily limit and the blocklist. Apollo sends from my own mailbox, adds my signature, and tracks opens and replies.
7. **Replies, through Apollo and Outlook.** A **replies** worker reads Apollo's tracking to see who replied. Apollo doesn't expose the reply text, so it uses Outlook search (read-only) to pull the first lines from my inbox. If Outlook errors, it carries on with Apollo's flag alone. The app counts sent, replied and booked per hook arm.

## Using the connectors

Apollo and Microsoft 365 are connected to my Claude account, so every Claude Code agent the app starts can see their tools. The app doesn't add them as `services`. Instead, the **policy hook decides which agent may call which connector tool**, by its full name:

```js
const AP = 'mcp__claude_ai_Apollo_io__';
const MS = 'mcp__claude_ai_Microsoft_365__';

finder:  [AP + 'apollo_mixed_companies_search', AP + 'apollo_organizations_enrich',
          AP + 'apollo_organizations_job_postings', AP + 'apollo_organizations_lookup'],
people:  [AP + 'apollo_mixed_people_api_search', AP + 'apollo_people_match', AP + 'apollo_email_validation_validate'],
email:   [],                                        // no connector tools
send:    [AP + 'apollo_contacts_search', AP + 'apollo_contacts_create',
          AP + 'apollo_emailer_messages_create', AP + 'apollo_emailer_messages_send_now',
          AP + 'apollo_emailer_messages_email_send_status'],
replies: [AP + 'apollo_emailer_messages_search', AP + 'apollo_emailer_messages_get_content',
          MS + 'outlook_email_search', MS + 'read_resource'],
manager: [],                                        // talks to me, hands work to workers; no connector tools
```

Lessons from wiring them up:

- **A connector exposes far more than you want.** Apollo has tools that create sequences, bulk-add contacts and buy mailboxes, and Microsoft 365 can send mail and delete threads. An allowlist per agent, by exact tool name, is the only thing that keeps that surface small. Anything not listed is refused.
- **Gate every step of a multi-step send.** Apollo sends in two calls (create, then send-now). Gating only the second would let an agent create something different and send it. Both calls are checked against the approved email, and send-now may only send the message that run just created.
- **Count credit-spending calls in the hook**, not in the prompt. Enrichment, people-match and validation are logged and capped per day.
- **Have a fallback connector.** I started out sending through Outlook. When my mailbox started returning errors through the connector, I moved sending to Apollo the same day. Because the gate compares against the approved text, the approval flow stayed the same: the switch was the executor's allowlist and how the gate reads the new tool's arguments. Outlook stayed on as a read-only source for reply text.
- **Mock both for demo mode.** A mock Apollo/Outlook MCP server returns made-up companies, people and replies under the same tool names, and the real connectors aren't loaded at all (`--strict-mcp-config`). The whole pipeline can be filmed end to end without a real contact on screen.

## As agentic-ui config

A sketch of the rest of `agents.config.js`:

```js
module.exports = {
  main: 'manager',
  agents: {
    manager: { label: 'Manager', prompt: 'prompts/manager.md', memory: true,
      tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      appTools: ['ask_agent', 'agent_result', 'show_panel', 'show_actions',
                 'write_canvas', 'list_companies', 'update_company', 'list_people', 'save_draft', 'remember', 'forget'] },
    finder:  { label: 'Finder',  worker: true,   prompt: 'prompts/finder.md',  tools: ['WebSearch', 'WebFetch', /* Apollo, above */], appTools: ['propose_companies', 'check_company'] },
    people:  { label: 'People',  worker: true,   prompt: 'prompts/people.md',  tools: [/* Apollo, above */], appTools: ['add_person'] },
    email:   { label: 'Email',   worker: true,   prompt: 'prompts/email.md',   tools: [], appTools: ['propose_action'] },
    sender:  { label: 'Send',    executor: true, prompt: 'prompts/sender.md',  tools: [/* Apollo send, above */], appTools: [] },
    replies: { label: 'Replies', worker: true,   prompt: 'prompts/replies.md', tools: [/* Apollo + Outlook, above */], appTools: ['mark_reply'] },
  },

  actions: {
    send_email: {
      label: 'Email',
      fields: { to: 'To', subject: 'Subject', body: 'Body' },
      required: ['to', 'subject', 'body'],
      executor: 'sender',
      tool: 'mcp__claude_ai_Apollo_io__apollo_emailer_messages_create', // plus send_now, checked the same way
      match: { to: 'to', subject: 'subject', body: 'body' },
      window: { start: '08:30', end: '17:30', days: [1, 2, 3, 4, 5], timeZone: 'Europe/London' },
      rate: { perDay: 20, gapMinutes: 10 },
      blocklist: 'to',
    },
  },
};
```

The app tools here (`propose_companies`, `check_company`, `add_person`, `mark_reply`) are your own, written in `tools`. Each one validates in code: duplicates, do-not-contact, banned words in a draft, and so on. The repo's gate checks one tool per action. For Apollo's two-step send I extended it to check both calls.

## What made it work

- **One agent to talk to.** I only type to the manager, in threads (one per sector, say). It does conversational work itself (the canvas, editing drafts with me) and hands batch work to workers. I can read the workers' logs but don't talk to them.
- **Workers start from events, not just from chat.** Keeping a company starts the people search, and adding a person starts a draft. The pipeline moves without me prompting each step.
- **The send is the only irreversible step, so it's the only thing behind the gate.** Everything before it is a draft I can change. The approve button checks the card's version, so if a draft changed after I looked at it, that click can't approve it.
- **Credits are capped, not approved one by one.** A daily limit in code was better than a card for every Apollo lookup.
- **Prompts are plain files read fresh each turn**, so I could tighten the email format mid-session without restarting.
- **Notebooks.** Agents remember what I liked and what I'd ruled out across conversations.

## Not built yet

- Follow-up emails on a cadence (only first contact so far; Apollo sequences would be the natural fit).
- More than one person per company.
- Running on an always-on machine. Emails only go out while the app is running.
