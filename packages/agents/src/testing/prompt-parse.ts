/** Parses the <source> blocks a prompt carried (shared by the fake OpenAI answer builders). */
export interface PromptSource {
  id: string;
  kind: string;
  label: string;
  live: boolean;
  fixture: boolean;
  text: string;
}

export function parseSources(text: string): PromptSource[] {
  const out: PromptSource[] = [];
  const re = /<source id="(S\d+)" kind="(\w+)" label="([^"]*)" live="(true|false)" fixture="(true|false)"(?: origin="[a-z_]+")? injection_suspected="(?:true|false)">\n([\s\S]*?)\n<\/source>/g;
  for (const m of text.matchAll(re)) out.push({ id: m[1], kind: m[2], label: m[3], live: m[4] === 'true', fixture: m[5] === 'true', text: m[6] });
  return out;
}
