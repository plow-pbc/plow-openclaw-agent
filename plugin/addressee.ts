// Whether a group text nobody tagged this line in is plainly for someone else (plow-openclaw-agent#123).
// The model decides most room events, but a text that calls another person by a pet name or by name, and
// never says this agent's name, is not a judgement call: "amor, don't forget to grab milk" once got "🥛".

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const either = (words: readonly string[]) => words.map(escape).join("|");
// Word edges that work past ASCII ("bebê", "mozão"), unlike \b.
const before = "(?<![\\p{L}\\p{N}])", after = "(?![\\p{L}\\p{N}])";

const PET_NAMES = [
  "amor", "amorzinho", "mor", "mozão", "mozao", "meu amor", "meu bem", "meu anjo", "minha vida", "vida", "querido", "querida",
  "bebê", "bebe", "nenê", "nene", "mi amor", "mi vida", "cariño", "carino",
  "honey", "hon", "hun", "babe", "baby", "love", "my love", "sweetie", "sweetheart", "darling",
];
// Words a text may open with before the name it calls: "Oi amor", "Bom dia, Camily".
const OPENERS = ["oi", "olá", "ola", "hi", "hey", "hello", "bom dia", "boa tarde", "boa noite", "good morning", "morning",
  "good night", "tchau", "bye", "thanks", "thank you", "obrigado", "obrigada", "valeu", "te amo", "love you"];
// Capitalized words that open a sentence with a comma without calling anyone: "So, …", "Guys, …" (the group).
const NOT_A_NAME = new Set(["so", "well", "yes", "yeah", "yep", "no", "nope", "ok", "okay", "also", "anyway", "and", "but", "then",
  "btw", "hey", "hi", "hello", "oi", "olá", "ola", "sim", "não", "nao", "bom", "então", "entao", "olha", "ei", "ah", "oh", "hmm",
  "wait", "actually", "look", "listen", "please", "thanks", "sorry", "guys", "everyone", "everybody", "all", "folks", "team",
  "pessoal", "gente", "galera", "todos", "people", "friends", "alright", "right", "sure", "cool", "great", "nice", "good",
  "perfect", "true", "honestly", "lol", "haha", "enfim", "aliás", "alias", "mas", "today", "tomorrow", "tonight", "hoje",
  "amanhã", "amanha", "agora", "now", "here", "there", "anyone", "someone", "alguém", "alguem"]);

const opener = `(?:(?:${either(OPENERS)})[\\s,!.]+)?`;
const trailing = "[\\s\\p{P}\\p{Extended_Pictographic}\\uFE0F\\u200D]*$";

export function addressedElsewhere(body: string, selfName: string | undefined, memberNames: readonly string[] = []): boolean {
  const text = body.trim();
  if (!text) return false;
  // A text that says this agent's name is for it, or for the model to judge.
  if (selfName?.trim() && new RegExp(`${before}${escape(selfName.trim())}${after}`, "iu").test(text)) return false;
  const names = memberNames.map(name => name.trim().split(/\s+/)[0] ?? "").filter(name => /^\p{L}[\p{L}'’-]+$/u.test(name));
  const called = either([...PET_NAMES, ...names]);
  // Called at the start ("amor, …", "Oi amor", "Honey can you …") or at the end ("drive safe amor ❤️").
  if (new RegExp(`^${opener}(?:${called})${after}`, "iu").test(text)) return true;
  if (new RegExp(`[\\s,](?:${called})${trailing}`, "iu").test(text)) return true;
  // Any capitalized name followed by a comma at the start: "Camily, did you book the dentist?" The opener is
  // stripped first: with the i flag, \p{Lu} would match lower case too.
  const vocative = text.replace(new RegExp(`^${opener}`, "iu"), "").match(/^(\p{Lu}[\p{L}'’-]+)\s*,/u);
  return vocative !== null && !NOT_A_NAME.has(vocative[1].toLowerCase());
}
