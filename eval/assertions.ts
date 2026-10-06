// This literal English check catches release-case claims, not arbitrary meaning.
// Human review still judges factual correctness and tone.
export function assertsPhrase(output: string, phrase: string): boolean {
  const text = output.toLowerCase(), claim = phrase.toLowerCase();
  if (!claim) return false;
  for (let index = text.indexOf(claim); index >= 0; index = text.indexOf(claim, index + claim.length)) {
    const prefix = text.slice(0, index).split(/[.!?;\n]|,?\s+\b(?:but|however)\b\s+/).at(-1) ?? "";
    const negated = /\b(?:not|never|cannot|can't|couldn't|won't|unconfirmed|uncertain|unable)\b/.test(prefix);
    const pendingVerification = /\b(?:before\s+(?:saying|claiming|confirming)|to\s+(?:confirm|verify))\s+(?:that\s+)?$/.test(prefix);
    if (!negated && !pendingVerification) return true;
  }
  return false;
}
