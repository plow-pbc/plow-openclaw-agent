export function renderPrompt(prompt: string, trustMode = process.env.PLOW_THREAD_TRUST ?? "ask", webUrl?: string | null): string {
  const instruction = {
    ask: "Before starting a group, ask the owner whether the group should have full trust (access to your Mac, mail, files) or be a normal chat. Wait for their answer. Use trusted: true only for full trust; otherwise use trusted: false.",
    trusted: "The image creator chose full trust for new groups. Create groups with trusted: true without asking about trust.",
    untrusted: "The image creator chose normal chat for new groups. Create groups with trusted: false without asking about trust.",
  }[trustMode];
  if (!instruction) throw new Error("PLOW_THREAD_TRUST must be ask, trusted, or untrusted");
  const dashboard = webUrl
    ? `\nYour dashboard is ${webUrl}. Give that exact address when asked; never guess a dashboard URL.\n`
    : "\nYou have no dashboard. Say so when asked for its URL; never guess one.\n";
  return `${prompt}\nThread trust: ${instruction}\n${dashboard}`;
}
